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
        CAPPluginMethod(name: "compareWithLastFull", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "vaultStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resolveProblems", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelBackup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "savedVault", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "relocate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
    ]

    private enum Source { case file(URL); case asset(PHAsset) }
    /// One file to back up. The name and size can change while the owner reviews a problem file (rename, or a new size after it was edited).
    private final class Item { var name: String; var bytes: Int64; var modified: Int64; let source: Source; init(_ n: String, _ b: Int64, _ m: Int64, _ s: Source) { name = n; bytes = b; modified = m; source = s } }
    private struct Pending { let address: String; let pin: String; let deviceId: String; let challenge: String; let profile: String; let phone: String }
    private struct Decision { let index: Int; let action: String; let name: String? }
    /// One file could not be read or changed while it was being copied. The backup carries on with the next file.
    private struct FileProblem: Error { let message: String; init(_ m: String) { message = m } }
    private final class Transfer {
        var state = "running"; var sent: Int64 = 0; var total: Int64 = 0; var reason: String?; var code: String?
        var pollAt: Date?; var pollSent: Int64 = 0; var speed: Double = 0
        /// Files that could not be copied and wait for the owner's decision (index -> reason), files already stored, and files the owner chose to skip.
        var problems: [Int: String] = [:]; var done = Set<Int>(); var skipped = Set<Int>()
        var decisions: [[Decision]] = []
        var cancel = false
        var items: [Item] = []
    }

    private var picked: [String: Item] = [:]
    private var scoped: [URL] = []
    private var pending: Pending?
    private var pickCall: CAPPluginCall?
    private var transfers: [String: Transfer] = [:]
    private let lock = NSLock()
    private static let chunkSize = 4 * 1024 * 1024
    private static let resumeWindow: TimeInterval = 15 * 60
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
            let modified = Int64((asset.modificationDate ?? asset.creationDate)?.timeIntervalSince1970 ?? 0)
            self.picked[id] = Item(name, bytes, modified, .asset(asset))
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
                let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .contentModificationDateKey])
                guard values?.isRegularFile == true else { return }
                let unique = self.unique(name, &names), id = UUID().uuidString
                let bytes = Int64(values?.fileSize ?? 0)
                self.picked[id] = Item(unique, bytes, Int64(values?.contentModificationDate?.timeIntervalSince1970 ?? 0), .file(url))
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

    @discardableResult private func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }
    private func transfer(_ call: CAPPluginCall) -> Transfer? { guard let id = call.getString("transferId") else { return nil }; return locked { transfers[id] } }
    private func stopIfCancelled(_ t: Transfer) throws { if locked({ t.cancel }) { throw Failure("Backup cancelled.", code: "cancelled") } }

    @objc func startBackup(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let kind = call.getString("kind"), let paths = call.getArray("paths", String.self) else { return call.reject("Missing backup details.") }
        let basedOn = call.getString("basedOn")
        let items = paths.compactMap { picked[$0] }
        guard items.count == paths.count, !items.isEmpty else { return call.reject("Choose your files again.") }
        Task {
            do {
                let (vault, deviceId, challenge) = try await self.proof()
                let total = items.reduce(Int64(0)) { $0 + $1.bytes }
                let message: [String: Any] = ["deviceId": deviceId, "challenge": challenge, "action": "backup", "name": name, "kind": kind, "files": items.count, "bytes": total]
                let signature = try Keys.signingKey().signature(for: Canonical.encode(message)).base64EncodedString()
                let listing: [[String: Any]] = items.map { item in
                    var row: [String: Any] = ["path": item.name, "bytes": item.bytes]
                    if item.modified > 0 { row["modified"] = item.modified }
                    return row
                }
                let paged = listing.count > Self.manifestPage
                var body: [String: Any] = ["deviceId": deviceId, "challenge": challenge, "signature": signature, "name": name, "kind": kind, "files": paged ? [[String: Any]]() : listing]
                if let basedOn, !basedOn.isEmpty { body["basedOn"] = basedOn }
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
                let transfer = Transfer(); transfer.total = total; transfer.items = items
                self.locked { self.transfers[id] = transfer }
                call.resolve(["transferId": id])
                await MainActor.run { UIApplication.shared.isIdleTimerDisabled = true }
                await self.run(vault, id, token, transfer)
                await MainActor.run { UIApplication.shared.isIdleTimerDisabled = false }
            } catch { self.fail(call, error) }
        }
    }

    private func run(_ vault: Vault, _ id: String, _ token: String, _ t: Transfer) async {
        let ids: [String: Any] = ["transferId": id, "token": token]
        do {
            // Pass 1: every file. A file that cannot be copied is parked and the next one starts.
            try await retrying(vault, ids, t) { index, offset in try await self.copyFrom(vault, id, token, t, index, offset) }
            // Review: the owner decides what happens to parked files (retry, rename, skip) before the backup is finished.
            while locked({ !t.problems.isEmpty }) {
                locked { t.state = "review"; t.reason = nil }
                var actions: [Decision]?
                var beat = Date()
                while actions == nil {
                    try stopIfCancelled(t)
                    actions = locked { t.decisions.isEmpty ? nil : t.decisions.removeFirst() }
                    if actions == nil {
                        try await Task.sleep(nanoseconds: 300_000_000)
                        // Keeps the Vault's idle timer from ending the backup while the owner is deciding.
                        if Date().timeIntervalSince(beat) > 30 { beat = Date(); _ = try? await vault.post("/v1/backup/resume", ids) }
                    }
                }
                try stopIfCancelled(t)
                locked { t.state = "running" }
                try await applyDecisions(vault, id, token, t, actions ?? [])
                try await retrying(vault, ids, t) { _, _ in try await self.copyFrom(vault, id, token, t, 0, 0) }
            }
            try await retrying(vault, ids, t) { _, _ in _ = try await vault.post("/v1/backup/finish", ids) }
            locked { t.state = "complete"; t.reason = nil }
        } catch {
            locked { t.state = "failed"; t.reason = error.localizedDescription; t.code = (error as? Failure)?.code }
            // Tell the Vault right away, so it stops instead of waiting for its idle timeout.
            _ = try? await vault.post("/v1/backup/abort", ids)
        }
    }

    /// Runs a step; when Wi-Fi drops (or a chunk is rejected) asks the Vault where it stopped and carries on from there.
    private func retrying(_ vault: Vault, _ ids: [String: Any], _ t: Transfer, _ step: (Int, Int64) async throws -> Void) async throws {
        var index = 0, stalls = 0
        var offset: Int64 = 0, lastSent: Int64 = -1
        while true {
            do { try stopIfCancelled(t); try await step(index, offset); return }
            catch let e as Failure {
                let network = e.code == "unreachable"
                if !network && e.code != "invalid_request" { throw e }
                let sentNow = locked { t.sent }
                if !network { if sentNow <= lastSent { stalls += 1 } else { stalls = 0 }; if stalls >= 3 { throw e } }
                lastSent = sentNow
                let since = Date(); var wait: UInt64 = 2
                while true {
                    try stopIfCancelled(t)
                    locked { t.state = "waiting"; t.reason = network ? "Waiting for your Vault to come back on Wi-Fi…" : "Retrying…" }
                    if Date().timeIntervalSince(since) > Self.resumeWindow { throw Failure("Could not reach your Vault for 15 minutes. Check that it is on and on the same Wi-Fi, then start again.", code: "unreachable") }
                    try await Task.sleep(nanoseconds: wait * 1_000_000_000); wait = min(wait * 2, 30)
                    do {
                        let r = try await vault.post("/v1/backup/resume", ids)
                        guard let nextIndex = (r["nextIndex"] as? NSNumber)?.intValue, let nextOffset = (r["nextOffset"] as? NSNumber)?.int64Value, let received = (r["receivedBytes"] as? NSNumber)?.int64Value else { throw Failure("The Vault sent an unexpected reply.") }
                        index = nextIndex; offset = nextOffset
                        locked { t.sent = received; t.state = "running"; t.reason = nil }
                        break
                    } catch let again as Failure { if again.code != "unreachable" { throw again } }
                }
            }
        }
    }

    /// Sends every file that is not yet stored, parked or skipped, starting at (startIndex, startOffset). Does not finish the backup.
    private func copyFrom(_ vault: Vault, _ id: String, _ token: String, _ t: Transfer, _ startIndex: Int, _ startOffset: Int64) async throws {
        guard startIndex < t.items.count else { return }
        for index in startIndex..<t.items.count {
            try stopIfCancelled(t)
            if locked({ t.done.contains(index) || t.skipped.contains(index) || t.problems[index] != nil }) { continue }
            let item = t.items[index]
            do { try await sendFile(vault, id, token, item, index, index == startIndex ? startOffset : 0, t); _ = locked { t.done.insert(index) } }
            catch let problem as FileProblem { try await reportProblem(vault, id, token, index, item, t, "\(item.name): \(problem.message)") }
        }
    }

    private final class Reader: @unchecked Sendable {
        let handle: FileHandle
        init(_ h: FileHandle) { handle = h }
        func next() throws -> Data { try handle.read(upToCount: HomeSafeVaultPlugin.chunkSize) ?? Data() }
    }

    private func sendFile(_ vault: Vault, _ id: String, _ token: String, _ item: Item, _ index: Int, _ startOffset: Int64, _ t: Transfer) async throws {
        let (url, temporary) = try await readable(item)
        defer { if temporary { try? FileManager.default.removeItem(at: url) } }
        let handle: FileHandle
        do { handle = try FileHandle(forReadingFrom: url) } catch { throw FileProblem("This file is no longer on the phone.") }
        defer { try? handle.close() }
        let reader = Reader(handle)
        var offset = startOffset
        do { if offset > 0 { try handle.seek(toOffset: UInt64(offset)) } } catch { throw FileProblem("The file changed while backing up.") }
        var current: Data
        do { current = try reader.next() } catch { throw FileProblem("The file could not be read.") }
        while true {
            try stopIfCancelled(t)
            if offset + Int64(current.count) > item.bytes { throw FileProblem("The file changed while backing up.") }
            // Reads the next chunk from storage while this one is on the network.
            let following: Task<Data, Error>? = offset + Int64(current.count) < item.bytes ? Task.detached { try reader.next() } : nil
            do { try await vault.chunk(id, token, index, offset, current) }
            catch { _ = try? await following?.value; throw error }
            offset += Int64(current.count)
            locked { t.sent += Int64(current.count) }
            guard let following, !current.isEmpty else { break }
            do { current = try await following.value } catch { throw FileProblem("The file could not be read.") }
        }
        if offset != item.bytes { throw FileProblem("The file changed while backing up.") }
    }

    private func reportProblem(_ vault: Vault, _ id: String, _ token: String, _ index: Int, _ item: Item, _ t: Transfer, _ why: String) async throws {
        let r = try await vault.post("/v1/backup/problem", ["transferId": id, "token": token, "index": index, "reason": String(why.prefix(200))])
        locked { if let received = (r["receivedBytes"] as? NSNumber)?.int64Value { t.sent = received }; t.problems[index] = why }
    }

    /// Applies the owner's choices for files that could not be copied.
    private func applyDecisions(_ vault: Vault, _ id: String, _ token: String, _ t: Transfer, _ actions: [Decision]) async throws {
        for a in actions {
            guard a.index >= 0, a.index < t.items.count, locked({ t.problems[a.index] != nil }) else { continue }
            let item = t.items[a.index]
            if a.action == "skip" { locked { t.problems[a.index] = nil; t.skipped.insert(a.index) }; continue }
            let oldName = item.name, oldBytes = item.bytes, oldModified = item.modified
            do {
                if a.action == "rename" {
                    let candidate = (a.name ?? item.name).split(separator: "/").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.map { Self.clean($0) }.joined(separator: "/")
                    if candidate.isEmpty { throw FileProblem("Type a name for this file.") }
                    if t.items.enumerated().contains(where: { $0.offset != a.index && $0.element.name.lowercased() == candidate.lowercased() }) { throw FileProblem("Another file in this backup already has that name.") }
                    item.name = candidate
                }
                item.bytes = try currentSize(item); item.modified = Int64(Date().timeIntervalSince1970)
                let r = try await vault.post("/v1/backup/replace", ["transferId": id, "token": token, "index": a.index, "path": item.name, "bytes": item.bytes, "modified": item.modified])
                locked {
                    if let received = (r["receivedBytes"] as? NSNumber)?.int64Value { t.sent = received }
                    if let total = (r["totalBytes"] as? NSNumber)?.int64Value { t.total = total }
                    t.problems[a.index] = nil
                }
            } catch {
                item.name = oldName; item.bytes = oldBytes; item.modified = oldModified
                let network = (error as? Failure)?.code == "unreachable"
                let why = (error as? FileProblem)?.message ?? (network ? "Could not reach your Vault. Try again." : "The Vault did not accept that name.")
                locked { t.problems[a.index] = why }
            }
        }
    }

    private func currentSize(_ item: Item) throws -> Int64 {
        switch item.source {
        case .file(let url):
            if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize { return Int64(size) }
        case .asset(let asset):
            if let resource = PHAssetResource.assetResources(for: asset).first, let size = (resource.value(forKey: "fileSize") as? NSNumber)?.int64Value { return size }
        }
        throw FileProblem("This file is no longer on the phone.")
    }

    private func readable(_ item: Item) async throws -> (URL, Bool) {
        switch item.source {
        case .file(let url): return (url, false)
        case .asset(let asset):
            guard let resource = PHAssetResource.assetResources(for: asset).first else { throw FileProblem("This file is no longer on the phone.") }
            let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let options = PHAssetResourceRequestOptions()
            options.isNetworkAccessAllowed = false // Zero cloud: never download originals from iCloud.
            try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
                PHAssetResourceManager.default().writeData(for: resource, toFile: temp, options: options) { error in
                    if error != nil { done.resume(throwing: FileProblem("This file is stored only in iCloud. HomeSafe never downloads from the cloud; keep originals on this iPhone or choose Custom folders.")) } else { done.resume() }
                }
            }
            return (temp, true)
        }
    }

    /// Finds this phone's latest complete Full backup on the Vault and works out which of the given items are new or changed since then.
    /// Returns { found: false } when there is no earlier Full backup. Items are compared by path and size, and by modified time when both sides have it.
    @objc func compareWithLastFull(_ call: CAPPluginCall) {
        guard let paths = call.getArray("paths", String.self) else { return call.reject("Choose your files again.") }
        Task {
            do {
                let (vault, deviceId, challenge) = try await self.proof()
                let message: [String: Any] = ["deviceId": deviceId, "challenge": challenge, "action": "baseline"]
                let signature = try Keys.signingKey().signature(for: Canonical.encode(message)).base64EncodedString()
                let first = try await vault.post("/v1/backup/baseline", ["deviceId": deviceId, "challenge": challenge, "signature": signature])
                guard (first["found"] as? Bool) == true, let token = first["token"] as? String else { return call.resolve(["found": false]) }
                var base: [String: (bytes: Int64, modified: Int64)] = [:] // modified is -1 when the Vault has none
                var page = first
                while true {
                    for e in page["entries"] as? [[String: Any]] ?? [] {
                        guard let path = e["path"] as? String, let bytes = (e["bytes"] as? NSNumber)?.int64Value else { continue }
                        base[path] = (bytes, (e["modified"] as? NSNumber)?.int64Value ?? -1)
                    }
                    guard let next = (page["next"] as? NSNumber)?.int64Value else { break }
                    page = try await vault.post("/v1/backup/baseline", ["deviceId": deviceId, "token": token, "offset": next])
                }
                var changed: [String] = [], changedBytes: Int64 = 0, unchanged = 0
                for id in paths {
                    guard let item = self.picked[id] else { throw Failure("Choose your files again.") }
                    if let b = base[item.name], b.bytes == item.bytes, b.modified < 0 || item.modified <= 0 || item.modified <= b.modified { unchanged += 1 }
                    else { changed.append(id); changedBytes += item.bytes }
                }
                call.resolve(["found": true, "name": first["name"] ?? "", "date": first["date"] ?? "", "files": first["files"] ?? 0, "bytes": first["bytes"] ?? 0,
                              "changed": changed, "changedCount": changed.count, "changedBytes": changedBytes, "unchangedCount": unchanged])
            } catch { self.fail(call, error) }
        }
    }

    /// Which drive the Vault saves to and its free space. With an address and fingerprint: a discovered Vault; without: the paired one.
    @objc func vaultStatus(_ call: CAPPluginCall) {
        Task {
            do {
                let address: String, pin: String
                if let given = call.getString("address") {
                    guard let fingerprint = call.getString("fingerprint") else { throw Failure("Missing Vault details.") }
                    address = given; pin = fingerprint
                } else {
                    guard let saved = Keys.loadPairing(), let a = saved["address"], let p = saved["pin"] else { throw Failure("This phone is not paired with a Vault yet.") }
                    address = a; pin = p
                }
                try Vault.requirePrivate(address)
                call.resolve(try await Vault(address: address, pin: pin).post("/v1/status", [:]))
            } catch { self.fail(call, error) }
        }
    }

    /// Decisions for files that could not be copied: [{ index, action: "retry" | "rename" | "skip", name? }].
    @objc func resolveProblems(_ call: CAPPluginCall) {
        guard let t = transfer(call), let raw = call.getArray("actions") else { return call.reject("Unknown transfer.") }
        let decisions = raw.compactMap { value -> Decision? in
            guard let a = value as? [String: Any], let action = a["action"] as? String, let index = (a["index"] as? NSNumber)?.intValue else { return nil }
            return Decision(index: index, action: action, name: a["name"] as? String)
        }
        locked { t.decisions.append(decisions) }
        call.resolve()
    }

    /// Stops the backup now, on the phone and on the Vault.
    @objc func cancelBackup(_ call: CAPPluginCall) {
        guard let t = transfer(call) else { return call.reject("Unknown transfer.") }
        locked { t.cancel = true }
        call.resolve()
    }

    @objc func transferStatus(_ call: CAPPluginCall) {
        guard let t = transfer(call) else { return call.reject("Unknown transfer.") }
        let out: [String: Any] = locked {
            let now = Date(), sent = t.sent
            if let at = t.pollAt, now > at { let inst = Double(sent - t.pollSent) / now.timeIntervalSince(at); t.speed = t.speed == 0 ? inst : 0.6 * t.speed + 0.4 * inst }
            t.pollAt = now; t.pollSent = sent
            if t.state != "running" { t.speed = 0 }
            var out: [String: Any] = ["state": t.state, "sentBytes": sent, "totalBytes": t.total, "bytesPerSecond": Int(max(0, t.speed).rounded())]
            if let reason = t.reason { out["reason"] = reason }
            if let code = t.code { out["code"] = code }
            out["problems"] = t.problems.keys.sorted().map { ["index": $0, "name": t.items[$0].name, "reason": t.problems[$0] ?? ""] as [String: Any] }
            out["skippedCount"] = t.skipped.count
            return out
        }
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
