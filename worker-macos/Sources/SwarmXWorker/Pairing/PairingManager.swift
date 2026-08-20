import Foundation
import CryptoKit

public struct EncryptedEnvelope: Codable {
    public let sessionId: String
    public let sequenceNum: Int64
    public let ivNonce: String // Base64
    public let ciphertext: String // Base64
    public let authTag: String // Base64
}

public class PairingManager {
    public static let shared = PairingManager()

    private var ephemeralPrivateKey: Curve25519.KeyAgreement.PrivateKey?
    public private(set) var salt: Data = Data()
    public private(set) var derivedSasCode: String?
    public private(set) var activeSessionId: String?
    public private(set) var activeSessionKey: SymmetricKey?
    public private(set) var hostToWorkerKey: SymmetricKey?
    public private(set) var workerToHostKey: SymmetricKey?
    private var sequenceNum: UInt64 = 0

    private let trustStoreKey = "SwarmXTrustedHost"

    private init() {}

    public func generateEphemeralKeypair() -> (publicKeyHex: String, saltHex: String) {
        let privateKey = Curve25519.KeyAgreement.PrivateKey()
        self.ephemeralPrivateKey = privateKey
        var randomSalt = Data(count: 16)
        _ = randomSalt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        self.salt = randomSalt
        let pubData = privateKey.publicKey.rawRepresentation
        return (pubData.hexString, randomSalt.hexString)
    }

    public var ephemeralPublicKeyHex: String {
        return ephemeralPrivateKey?.publicKey.rawRepresentation.hexString ?? ""
    }

    public static func deriveSasCode(sharedSecret: SharedSecret, salt: Data, contextInfo: String = "swarmx-sas-v1") -> String {
        let info = contextInfo.data(using: .utf8)!
        let derivedKey = sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: salt,
            sharedInfo: info,
            outputByteCount: 4
        )
        let keyData = derivedKey.withUnsafeBytes { Data($0) }
        let num = UInt32(bigEndian: keyData.withUnsafeBytes { $0.load(as: UInt32.self) })
        let code = (num % 9000) + 1000
        return String(code)
    }

    public static func deriveSessionKey(sharedSecret: SharedSecret, salt: Data, contextInfo: String = "swarmx-session-key-v1") -> SymmetricKey {
        let info = contextInfo.data(using: .utf8)!
        return sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: salt,
            sharedInfo: info,
            outputByteCount: 32
        )
    }

    public func computeSharedSecretAndSas(hostPublicKeyHex: String, hostDeviceId: String = "swarmx-host", workerDeviceId: String = "worker") throws -> String {
        guard let privateKey = ephemeralPrivateKey else {
            throw NSError(domain: "SwarmX", code: 1, userInfo: [NSLocalizedDescriptionKey: "No ephemeral key"])
        }

        guard let hostPubData = Data(hexString: hostPublicKeyHex),
              let hostPublicKey = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: hostPubData) else {
            throw NSError(domain: "SwarmX", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid host public key"])
        }

        let sharedSecret = try privateKey.sharedSecretFromKeyAgreement(with: hostPublicKey)
        let sasContext = "swarmx-sas-v1:\(hostDeviceId):\(workerDeviceId):\(hostPublicKeyHex):\(self.ephemeralPublicKeyHex)"
        let sasCode = PairingManager.deriveSasCode(sharedSecret: sharedSecret, salt: self.salt, contextInfo: sasContext)
        self.derivedSasCode = sasCode

        // Derive separate directional keys for host-to-worker and worker-to-host streams
        self.hostToWorkerKey = PairingManager.deriveSessionKey(sharedSecret: sharedSecret, salt: self.salt, contextInfo: "swarmx-host-to-worker-v1")
        self.workerToHostKey = PairingManager.deriveSessionKey(sharedSecret: sharedSecret, salt: self.salt, contextInfo: "swarmx-worker-to-host-v1")
        self.activeSessionKey = self.workerToHostKey

        return sasCode
    }

    public func activateSession(sessionId: String, hostToWorkerKey: SymmetricKey? = nil, workerToHostKey: SymmetricKey? = nil) {
        self.activeSessionId = sessionId
        if let h2w = hostToWorkerKey { self.hostToWorkerKey = h2w }
        if let w2h = workerToHostKey { 
            self.workerToHostKey = w2h
            self.activeSessionKey = w2h
        }
        self.sequenceNum = 0
        UserDefaults.standard.set(true, forKey: trustStoreKey)
    }

    public func isHostTrusted() -> Bool {
        return UserDefaults.standard.bool(forKey: trustStoreKey)
    }

    public func revokeTrust() {
        UserDefaults.standard.removeObject(forKey: trustStoreKey)
        self.activeSessionId = nil
        self.activeSessionKey = nil
        self.hostToWorkerKey = nil
        self.workerToHostKey = nil
        self.ephemeralPrivateKey = nil
    }

    public func encryptEnvelope(payload: Data) throws -> EncryptedEnvelope {
        guard let key = workerToHostKey ?? activeSessionKey, let sessionId = activeSessionId else {
            throw NSError(domain: "SwarmX", code: 3, userInfo: [NSLocalizedDescriptionKey: "No active session"])
        }

        self.sequenceNum += 1
        let aad = "\(sessionId):\(self.sequenceNum)".data(using: .utf8)!
        let sealed = try AES.GCM.seal(payload, using: key, authenticating: aad)

        let ivBase64 = sealed.nonce.withUnsafeBytes { Data($0) }.base64EncodedString()
        let ciphertextBase64 = sealed.ciphertext.base64EncodedString()
        let tagBase64 = sealed.tag.base64EncodedString()

        return EncryptedEnvelope(
            sessionId: sessionId,
            sequenceNum: Int64(self.sequenceNum),
            ivNonce: ivBase64,
            ciphertext: ciphertextBase64,
            authTag: tagBase64
        )
    }

    public func decryptEnvelope(envelope: EncryptedEnvelope) throws -> Data {
        guard let key = hostToWorkerKey ?? activeSessionKey else {
            throw NSError(domain: "SwarmX", code: 4, userInfo: [NSLocalizedDescriptionKey: "No active session"])
        }

        guard let ivData = Data(base64Encoded: envelope.ivNonce),
              let ciphertext = Data(base64Encoded: envelope.ciphertext),
              let tag = Data(base64Encoded: envelope.authTag) else {
            throw NSError(domain: "SwarmX", code: 5, userInfo: [NSLocalizedDescriptionKey: "Invalid envelope format"])
        }

        let aad = "\(envelope.sessionId):\(envelope.sequenceNum)".data(using: .utf8)!
        let nonce = try AES.GCM.Nonce(data: ivData)
        let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
        return try AES.GCM.open(sealedBox, using: key, authenticating: aad)
    }
}

extension Data {
    var hexString: String {
        return self.map { String(format: "%02x", $0) }.joined()
    }

    init?(hexString: String) {
        let len = hexString.count / 2
        var data = Data(capacity: len)
        var index = hexString.startIndex
        for _ in 0..<len {
            let nextIndex = hexString.index(index, offsetBy: 2)
            let bytes = hexString[index..<nextIndex]
            if let byte = UInt8(bytes, radix: 16) {
                data.append(byte)
            } else {
                return nil
            }
            index = nextIndex
        }
        self = data
    }
}
