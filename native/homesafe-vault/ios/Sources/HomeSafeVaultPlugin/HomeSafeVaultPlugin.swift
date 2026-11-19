import Foundation
import Capacitor
import CoreLocation
import CryptoKit
import NetworkExtension
import Photos
import Security
import UIKit
import UniformTypeIdentifiers

/// Native side of window.HomeSafeNative on iPhone/iPad.
/// Holds the device key and Vault pin in the Keychain; files go phone -> Vault over pinned TLS only.
@objc(HomeSafeVaultPlugin)
public class HomeSafeVaultPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "HomeSafeVaultPlugin"
    public let jsName = "HomeSafeVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "wifi", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discover", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "begin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "catalog", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pick", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startBackup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transferStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "savedVault", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "relocate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
    ]

    private enum Source { case file(URL); case asset(PHAsset) }
    private struct Item { let name: String; let bytes: Int64; let source: Source }
    private struct Pending { let address: String; let pin: String; let deviceId: String; let challenge: String; let profile: String; let phone: String }
    private final class Transfer { var state = "running"; var sent: Int64 = 0; var total: Int64 = 0; var reason: String?; var code: String? }

    private var picked: [String: Item] = [:]
    private var scoped: [URL] = []
    private var pending: Pending?
    private var pickCall: CAPPluginCall?
    private var transfers: [String: Transfer] = [:]
    private let lock = NSLock()
    private static let chunkSize = 4 * 1024 * 1024
    static let manifestPage = 5000

    // MARK: Wi-Fi

    private let location = CLLocationManager()
    private var browser: Discovery?

    /// Wi-Fi name via NEHotspotNetwork (needs the Access Wi-Fi Information entitlement + location "when in use").
    @objc func wifi(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.location.authorizationStatus == .notDetermined { self.location.requestWhenInUseAuthorization() }
            NEHotspotNetwork.fetchCurrent { network in
                var out: [String: Any] = ["wifi": network != nil]
                if let ssid = network?.ssid, !ssid.isEmpty { out["name"] = ssid }
                call.resolve(out)
            }
        }
    }

    /// Finds Vaults announcing _homesafe._tcp on this Wi-Fi for up to 4 seconds.
    @objc func discover(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let d = Discovery(); self.browser = d
            d.start { vaults in call.resolve(["vaults": vaults]); self.browser = nil }
        }
    }

    // MARK: Pairing

    @objc func begin(_ call: CAPPluginCall) {
        guard let email = call.getString("email"), let code = call.getString("code"),
              let address = call.getString("address"), let pin = call.getString("fingerprint")?.lowercased() else { return call.reject("Missing pairing details.") }
        Task {
            do {
                try Vault.requirePrivate(address)
                let key = try Keys.signingKey()
                let deviceId = try Keys.deviceId()
                let publicKey = key.publicKey.rawRepresentation.base64EncodedString()
                var body: [String: Any] = ["email": email, "code": code, "deviceId": deviceId, "publicKey": publicKey]
                body["signature"] = try key.signature(for: Canonical.encode(body)).base64EncodedString()
                let offer = try await Vault(address: address, pin: pin).post("/v1/pair/begin", body)
                guard let requestId = offer["requestId"] as? String, let challenge = offer["challenge"] as? String,
                      let profile = offer["profile"] as? String, let phone = offer["phone"] as? String else { throw Failure("The Vault sent an unexpected reply.") }
                self.pending = Pending(address: address, pin: pin, deviceId: deviceId, challenge: challenge, profile: profile, phone: phone)
                call.resolve(["requestId": requestId, "expiresAt": offer["expiresAt"] ?? 0, "email": offer["email"] ?? "", "profile": profile, "phone": phone])
            } catch { self.fail(call, error) }
        }
    }

    @objc func confirm(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId"), let p = pending else { return call.reject("Start pairing again.") }
        Task {
            do {
                let message: [String: Any] = ["requestId": requestId, "challenge": p.challenge, "profile": p.profile, "phone": p.phone]
                let signature = try Keys.signingKey().signature(for: Canonical.encode(message)).base64EncodedString()
                let session = try await Vault(address: p.address, pin: p.pin).post("/v1/pair/confirm", ["requestId": requestId, "signature": signature])
                try Keys.savePairing(["address": p.address, "pin": p.pin, "deviceId": p.deviceId])
                self.pending = nil
                call.resolve(session)
            } catch { self.fail(call, error) }
        }
    }

    @objc func catalog(_ call: CAPPluginCall) {
        Task {
            do {
                let (vault, deviceId, challenge) = try await self.proof()
                let message: [String: Any] = ["deviceId": deviceId, "challenge": challenge, "action": "catalog"]
                let signature = try Keys.signingKey().signature(for: Canonical.encode(message)).base64EncodedString()
                call.resolve(try await vault.post("/v1/backups", ["deviceId": deviceId, "challenge": challenge, "signature": signature]))
            } catch { self.fail(call, error) }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) { releaseScoped(); picked = [:]; call.resolve() }

    /// Passes the Vault's error code (code_expired, phone_revoked, ...) to the screens.
    private func fail(_ call: CAPPluginCall, _ error: Error) { call.reject(error.localizedDescription, (error as? Failure)?.code) }

    /// Saved Vault address and pinned fingerprint (no keys), used to find the Vault again after an IP change.
    @objc func savedVault(_ call: CAPPluginCall) {
        guard let saved = Keys.loadPairing(), let address = saved["address"], let pin = saved["pin"] else { return call.resolve([:]) }
        call.resolve(["address": address, "fingerprint": pin])
    }

    /// Updates the saved address only when the new Vault presents the same pinned fingerprint.
    @objc func relocate(_ call: CAPPluginCall) {
        do {
            guard let address = call.getString("address"), let pin = call.getString("fingerprint")?.replacingOccurrences(of: ":", with: "").lowercased() else { throw Failure("Missing Vault details.") }
            try Vault.requirePrivate(address)
            guard var saved = Keys.loadPairing() else { throw Failure("This phone is not paired with a Vault yet.") }
            guard saved["pin"] == pin else { throw Failure("A different Vault answered at that address. Pair again only if you replaced your Vault.", code: "certificate_mismatch") }
            saved["address"] = address
            try Keys.savePairing(saved)
            call.resolve()
        } catch { fail(call, error) }
    }

    /// Removes the saved pairing (for example after phone_revoked). The device key stays.
    @objc func forget(_ call: CAPPluginCall) { Keys.clearPairing(); pending = nil; releaseScoped(); picked = [:]; call.resolve() }

    private func proof() async throws -> (Vault, String, String) {
        guard let saved = Keys.loadPairing(), let address = saved["address"], let pin = saved["pin"], let deviceId = saved["deviceId"] else { throw Failure("This phone is not paired with a Vault yet.") }
        let vault = Vault(address: address, pin: pin)
        let reply = try await vault.post("/v1/device/challenge", ["deviceId": deviceId])
        guard let challenge = reply["challenge"] as? String else { throw Failure("The Vault sent an unexpected reply.") }
        return (vault, deviceId, challenge)
    }

    // MARK: File access

    @objc func pick(_ call: CAPPluginCall) {
        releaseScoped(); picked = [:]
        if call.getString("kind") == "Full" {
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
                guard status == .authorized || status == .limited else { return call.reject("Photo access was declined. Allow it in Settings → HomeSafe → Photos.") }
                DispatchQueue.global(qos: .userInitiated).async { self.loadLibrary(call) }
            }
        } else {
            DispatchQueue.main.async {
                let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item, .folder], asCopy: false)
                picker.allowsMultipleSelection = true
                picker.delegate = self
                self.pickCall = call
                self.bridge?.viewController?.present(picker, animated: true)
            }
        }
    }

    private func loadLibrary(_ call: CAPPluginCall) {
        var names = Set<String>(), result: [[String: Any]] = []
        PHAsset.fetchAssets(with: nil).enumerateObjects { asset, _, _ in
            guard let resource = PHAssetResource.assetResources(for: asset).first else { return }
            let bytes = (resource.value(forKey: "fileSize") as? NSNumber)?.int64Value ?? 0
            let name = self.unique("Photos/" + Self.clean(resource.originalFilename), &names)
            let id = UUID().uuidString
            self.picked[id] = Item(name: name, bytes: bytes, source: .asset(asset))
            result.append(["name": name, "path": id, "bytes": bytes])
        }
        call.resolve(["items": result])
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickCall else { return }
        pickCall = nil
        DispatchQueue.global(qos: .userInitiated).async {
            var names = Set<String>(), result: [[String: Any]] = []
            func add(_ url: URL, _ name: String) {
                let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                guard values?.isRegularFile == true else { return }
                let unique = self.unique(name, &names), id = UUID().uuidString
                let bytes = Int64(values?.fileSize ?? 0)
                self.picked[id] = Item(name: unique, bytes: bytes, source: .file(url))
                result.append(["name": unique, "path": id, "bytes": bytes])
            }
            for url in urls {
                if url.startAccessingSecurityScopedResource() { self.scoped.append(url) }
                if (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true {
                    let base = url.standardizedFileURL.path
                    let walker = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey], options: [.skipsHiddenFiles])
                    while let file = walker?.nextObject() as? URL {
                        let relative = String(file.standardizedFileURL.path.dropFirst(base.count)).split(separator: "/").map { Self.clean(String($0)) }.joined(separator: "/")
                        add(file, Self.clean(url.lastPathComponent) + "/" + relative)
                    }
                } else { add(url, Self.clean(url.lastPathComponent)) }
            }
            call.resolve(["items": result])
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickCall?.reject("Nothing was chosen."); pickCall = nil
    }

    private func releaseScoped() { scoped.forEach { $0.stopAccessingSecurityScopedResource() }; scoped = [] }

    private static func clean(_ s: String) -> String {
        var v = s.replacingOccurrences(of: "[\\\\/<>:\"|?*\\x00-\\x1f]", with: "_", options: .regularExpression)
        while v.hasSuffix(".") || v.hasSuffix(" ") { v.removeLast() }
        if v.isEmpty || v == ".." { v = "file" }
        return String(v.prefix(80))
    }

    private func unique(_ name: String, _ seen: inout Set<String>) -> String {
        var candidate = name, n = 2
        while seen.contains(candidate.lowercased()) {
            let url = URL(fileURLWithPath: name), ext = url.pathExtension
            let stem = ext.isEmpty ? name : String(name.dropLast(ext.count + 1))
            candidate = "\(stem) (\(n))" + (ext.isEmpty ? "" : ".\(ext)"); n += 1
        }
        seen.insert(candidate.lowercased()); return candidate
    }

    // MARK: Transfer

    @objc func startBackup(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let kind = call.getString("kind"), let paths = call.getArray("paths", String.self) else { return call.reject("Missing backup details.") }
        let items = paths.compactMap { picked[$0] }
        guard items.count == paths.count, !items.isEmpty else { return call.reject("Choose your files again.") }
        Task {
            do {
                let (vault, deviceId, challenge) = try await self.proof()
                let total = items.reduce(Int64(0)) { $0 + $1.bytes }
                let message: [String: Any] = ["deviceId": deviceId, "challenge": challenge, "action": "backup", "name": name, "kind": kind, "files": items.count, "bytes": total]
                let signature = try Keys.signingKey().signature(for: Canonical.encode(message)).base64EncodedString()
                let listing: [[String: Any]] = items.map { ["path": $0.name, "bytes": $0.bytes] }
                let paged = listing.count > Self.manifestPage
                var body: [String: Any] = ["deviceId": deviceId, "challenge": challenge, "signature": signature, "name": name, "kind": kind, "files": paged ? [[String: Any]]() : listing]
                if paged { body["fileCount"] = listing.count; body["bytes"] = total }
                let started = try await vault.post("/v1/backup/start", body)
                guard let id = started["transferId"] as? String, let token = started["token"] as? String else { throw Failure("The Vault did not accept the backup.") }
                // Above 5,000 files the manifest goes in pages before any chunk is sent.
                if paged {
                    for offset in stride(from: 0, to: listing.count, by: Self.manifestPage) {
                        let page = Array(listing[offset..<min(offset + Self.manifestPage, listing.count)])
                        _ = try await vault.post("/v1/backup/files", ["transferId": id, "token": token, "offset": offset, "files": page])
                    }
                }
                let transfer = Transfer(); transfer.total = total
                self.lock.lock(); self.transfers[id] = transfer; self.lock.unlock()
                call.resolve(["transferId": id])
                await MainActor.run { UIApplication.shared.isIdleTimerDisabled = true }
                await self.run(vault, id, token, items, transfer)
                await MainActor.run { UIApplication.shared.isIdleTimerDisabled = false }
            } catch { self.fail(call, error) }
        }
    }

    private func run(_ vault: Vault, _ id: String, _ token: String, _ items: [Item], _ t: Transfer) async {
        do {
            for (index, item) in items.enumerated() {
                let (url, temporary) = try await readable(item)
                defer { if temporary { try? FileManager.default.removeItem(at: url) } }
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                var offset: Int64 = 0
                repeat {
                    let chunk = try handle.read(upToCount: Self.chunkSize) ?? Data()
                    if offset + Int64(chunk.count) > item.bytes { throw Failure("\(item.name) changed while backing up. Choose it again.") }
                    try await vault.chunk(id, token, index, offset, chunk)
                    offset += Int64(chunk.count)
                    lock.lock(); t.sent += Int64(chunk.count); lock.unlock()
                    if chunk.isEmpty { break }
                } while offset < item.bytes
                if offset != item.bytes { throw Failure("\(item.name) changed while backing up. Choose it again.") }
            }
            _ = try await vault.post("/v1/backup/finish", ["transferId": id, "token": token])
            lock.lock(); t.state = "complete"; lock.unlock()
        } catch {
            lock.lock(); t.state = "failed"; t.reason = error.localizedDescription; t.code = (error as? Failure)?.code; lock.unlock()
        }
    }

    private func readable(_ item: Item) async throws -> (URL, Bool) {
        switch item.source {
        case .file(let url): return (url, false)
        case .asset(let asset):
            guard let resource = PHAssetResource.assetResources(for: asset).first else { throw Failure("\(item.name) is no longer on this phone.") }
            let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let options = PHAssetResourceRequestOptions()
            options.isNetworkAccessAllowed = false // Zero cloud: never download originals from iCloud.
            try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
                PHAssetResourceManager.default().writeData(for: resource, toFile: temp, options: options) { error in
                    if error != nil { done.resume(throwing: Failure("\(item.name) is stored only in iCloud. HomeSafe never downloads from the cloud; keep originals on this iPhone or choose Custom folders.")) } else { done.resume() }
                }
            }
            return (temp, true)
        }
    }

    @objc func transferStatus(_ call: CAPPluginCall) {
        lock.lock(); defer { lock.unlock() }
        guard let id = call.getString("transferId"), let t = transfers[id] else { return call.reject("Unknown transfer.") }
        var out: [String: Any] = ["state": t.state, "sentBytes": t.sent, "totalBytes": t.total]
        if let reason = t.reason { out["reason"] = reason }
        if let code = t.code { out["code"] = code }
        call.resolve(out)
    }
}

struct Failure: LocalizedError { let message: String; let code: String?; init(_ m: String, code: String? = nil) { message = m; self.code = code }; var errorDescription: String? { message } }

/// Pinned HTTPS client for a literal private IPv4 Vault. No redirects, no system trust.
final class Vault: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    let base: URL; let pin: String
    private lazy var session = URLSession(configuration: { let c = URLSessionConfiguration.ephemeral; c.timeoutIntervalForRequest = 30; c.urlCache = nil; return c }(), delegate: self, delegateQueue: nil)
    init(address: String, pin: String) { self.base = URL(string: address)!; self.pin = pin.replacingOccurrences(of: ":", with: "").lowercased() }

    static func requirePrivate(_ address: String) throws {
        guard let url = URL(string: address), url.scheme == "https", let host = url.host else { throw Failure("Use your Vault's local HTTPS address.") }
        let b = host.split(separator: ".").compactMap { Int($0) }
        guard b.count == 4, b.allSatisfy({ (0...255).contains($0) }), b[0] == 10 || (b[0] == 172 && (16...31).contains(b[1])) || (b[0] == 192 && b[1] == 168) else { throw Failure("Use an address on your private home network.") }
    }

    func post(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    func chunk(_ id: String, _ token: String, _ index: Int, _ offset: Int64, _ data: Data) async throws {
        var request = URLRequest(url: base.appendingPathComponent("/v1/backup/chunk"))
        request.httpMethod = "POST"
        for (k, v) in ["X-Transfer-Id": id, "X-Transfer-Token": token, "X-File-Index": String(index), "X-Offset": String(offset), "X-Sha256": SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), "Content-Type": "application/octet-stream"] { request.setValue(v, forHTTPHeaderField: k) }
        request.httpBody = data
        _ = try await send(request)
    }

    private func send(_ request: URLRequest) async throws -> [String: Any] {
        try Vault.requirePrivate(base.absoluteString)
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) } catch {
            if (error as? URLError)?.code == .cancelled { throw Failure("Your Vault's certificate does not match. Pair again only if you changed it on purpose.", code: "certificate_mismatch") }
            throw Failure("Lost contact with your Vault. Check Wi-Fi and that the Vault is running.", code: "unreachable")
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Failure(json["error"] as? String ?? "The Vault rejected the request.", code: json["code"] as? String) }
        return json
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = challenge.protectionSpace.serverTrust,
              let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else { return completionHandler(.cancelAuthenticationChallenge, nil) }
        let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map { String(format: "%02x", $0) }.joined()
        if digest == pin { completionHandler(.useCredential, URLCredential(trust: trust)) } else { completionHandler(.cancelAuthenticationChallenge, nil) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Matches the Node Vault's canonical JSON (sorted keys, no whitespace, JSON.stringify escaping) for flat objects. Checked against protocol/test-vectors.json.
enum Canonical {
    static func encode(_ value: [String: Any]) throws -> Data {
        let parts = try value.keys.sorted().map { key -> String in
            let v = value[key]!
            let encoded: String
            if let s = v as? String { encoded = quote(s) } else if let i = v as? Int { encoded = String(i) } else if let i = v as? Int64 { encoded = String(i) } else { throw Failure("Unsupported signed value.") }
            return quote(key) + ":" + encoded
        }
        return Data(("{" + parts.joined(separator: ",") + "}").utf8)
    }
    static func quote(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{8}": out += "\\b"
            case "\u{c}": out += "\\f"
            default: if u.value < 0x20 { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
            }
        }
        return out + "\""
    }
}

/// Device-only Keychain storage for the signing key, device id and pinned Vault.
enum Keys {
    private static func read(_ account: String) -> Data? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.homesafe.vault", kSecAttrAccount as String: account, kSecReturnData as String: true]
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }
    private static func write(_ account: String, _ data: Data) throws {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.homesafe.vault", kSecAttrAccount as String: account]
        SecItemDelete(q as CFDictionary)
        var add = q; add[kSecValueData as String] = data; add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw Failure("Could not save the device key securely.") }
    }
    static func signingKey() throws -> Curve25519.Signing.PrivateKey {
        if let raw = read("signing-key") { return try Curve25519.Signing.PrivateKey(rawRepresentation: raw) }
        let key = Curve25519.Signing.PrivateKey(); try write("signing-key", key.rawRepresentation); return key
    }
    static func deviceId() throws -> String {
        if let raw = read("device-id"), let s = String(data: raw, encoding: .utf8) { return s }
        let id = "ios_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        try write("device-id", Data(id.utf8)); return id
    }
    static func savePairing(_ value: [String: String]) throws { try write("pairing", JSONSerialization.data(withJSONObject: value)) }
    static func clearPairing() {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.homesafe.vault", kSecAttrAccount as String: "pairing"]
        SecItemDelete(q as CFDictionary)
    }
    static func loadPairing() -> [String: String]? { read("pairing").flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] } }
}

/// Bonjour browser for the Vault's announcement; reads address, port and certificate pin from TXT.
final class Discovery: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    private let browser = NetServiceBrowser()
    private var services: [NetService] = []
    private var found: [[String: String]] = []
    func start(_ done: @escaping ([[String: String]]) -> Void) {
        browser.delegate = self
        browser.searchForServices(ofType: "_homesafe._tcp.", inDomain: "local.")
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.browser.stop(); done(self.found) }
    }
    func netServiceBrowser(_ b: NetServiceBrowser, didFind s: NetService, moreComing: Bool) { services.append(s); s.delegate = self; s.resolve(withTimeout: 3) }
    func netServiceDidResolveAddress(_ s: NetService) {
        guard let txt = s.txtRecordData() else { return }
        let record = NetService.dictionary(fromTXTRecord: txt)
        guard let fp = record["fp"].flatMap({ String(data: $0, encoding: .utf8) }) else { return }
        let version = record["v"].flatMap { String(data: $0, encoding: .utf8) } ?? ""
        let label = record["name"].flatMap { String(data: $0, encoding: .utf8) } ?? s.name
        for data in s.addresses ?? [] {
            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                guard let sa = raw.baseAddress?.assumingMemoryBound(to: sockaddr.self), sa.pointee.sa_family == sa_family_t(AF_INET) else { return }
                var sin = raw.load(as: sockaddr_in.self)
                var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                inet_ntop(AF_INET, &sin.sin_addr, &buf, socklen_t(INET_ADDRSTRLEN))
                found.append(["name": label, "v": version, "address": "https://\(String(cString: buf)):\(s.port)", "fingerprint": fp])
            }
        }
    }
}
