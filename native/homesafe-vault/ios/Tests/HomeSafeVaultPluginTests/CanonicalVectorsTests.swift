import CryptoKit
import Foundation
import XCTest
@testable import HomeSafeVaultPlugin

/// Canonical.encode must produce exactly the bytes the Vault verifies (protocol/test-vectors.json).
final class CanonicalVectorsTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../protocol/test-vectors.json").standardizedFileURL
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }

    private func flat(_ input: [String: Any]) -> [String: Any] {
        input.mapValues { v in (v as? String) ?? ((v as! NSNumber).int64Value as Any) }
    }

    func testCanonicalMatchesVault() throws {
        for v in try vectors()["vectors"] as! [[String: Any]] {
            let encoded = try Canonical.encode(flat(v["input"] as! [String: Any]))
            XCTAssertEqual(String(decoding: encoded, as: UTF8.self), v["canonical"] as? String, v["name"] as? String ?? "")
        }
    }

    /// CryptoKit Ed25519 signatures are randomized, so check that the Vault's signatures verify and ours verify too.
    func testSignaturesInteroperate() throws {
        let all = try vectors()
        let seedHex = all["seedHex"] as! String
        let seed = Data(stride(from: 0, to: 64, by: 2).map { UInt8(seedHex[seedHex.index(seedHex.startIndex, offsetBy: $0)...].prefix(2), radix: 16)! })
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        XCTAssertEqual(key.publicKey.rawRepresentation.base64EncodedString(), all["publicKey"] as? String)
        for v in all["vectors"] as! [[String: Any]] {
            let bytes = Data((v["canonical"] as! String).utf8)
            XCTAssertTrue(key.publicKey.isValidSignature(Data(base64Encoded: v["signature"] as! String)!, for: bytes))
            XCTAssertTrue(key.publicKey.isValidSignature(try key.signature(for: bytes), for: bytes))
        }
    }
}
