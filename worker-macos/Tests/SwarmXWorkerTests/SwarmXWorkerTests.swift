import XCTest
import CryptoKit
@testable import SwarmXWorker

final class SwarmXWorkerTests: XCTestCase {
    func testCapabilityProfileVersion() {
        let profile = CapabilityProfile(deviceId: "test-device", deviceName: "Test Mac")
        XCTAssertEqual(profile.capabilitySchemaVersion, 1)
        XCTAssertEqual(profile.osType, "darwin")
        XCTAssertGreaterThan(profile.cpuCores, 0)
        XCTAssertGreaterThan(profile.totalRamMb, 0)
    }

    func testTelemetryCollection() {
        let telemetry = TelemetryProvider.shared.collectTelemetry(deviceId: "test-device")
        XCTAssertEqual(telemetry.deviceId, "test-device")
        XCTAssertGreaterThanOrEqual(telemetry.batteryLevel, 0.0)
        XCTAssertLessThanOrEqual(telemetry.batteryLevel, 1.0)
        XCTAssertGreaterThanOrEqual(telemetry.thermalState.rawValue, 0)
        XCTAssertLessThanOrEqual(telemetry.thermalState.rawValue, 3)
    }

    func testPairingKeyAgreementAndSasDerivation() throws {
        let hostDeviceId = "swarmx-host"
        let workerDeviceId = "test-worker"

        // Host keypair
        let hostPrivateKey = Curve25519.KeyAgreement.PrivateKey()
        let hostPublicKeyHex = hostPrivateKey.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined()

        // Worker generates keypair
        let (workerPubHex, _) = PairingManager.shared.generateEphemeralKeypair()
        XCTAssertFalse(workerPubHex.isEmpty)

        // Worker computes SAS
        let workerSas = try PairingManager.shared.computeSharedSecretAndSas(
            hostPublicKeyHex: hostPublicKeyHex,
            hostDeviceId: hostDeviceId,
            workerDeviceId: workerDeviceId
        )
        XCTAssertEqual(workerSas.count, 4)

        // Verify Host computes identical SAS
        guard let workerPubData = Data(hexString: workerPubHex),
              let workerPublicKey = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: workerPubData) else {
            XCTFail("Failed to reconstruct worker public key")
            return
        }

        let hostSharedSecret = try hostPrivateKey.sharedSecretFromKeyAgreement(with: workerPublicKey)
        let sasContext = "swarmx-sas-v1:\(hostDeviceId):\(workerDeviceId):\(hostPublicKeyHex):\(workerPubHex)"
        let hostSas = PairingManager.deriveSasCode(
            sharedSecret: hostSharedSecret,
            salt: PairingManager.shared.salt,
            contextInfo: sasContext
        )

        XCTAssertEqual(workerSas, hostSas)
    }

    func testEncryptedEnvelopeWithAad() throws {
        let key = SymmetricKey(size: .bits256)
        PairingManager.shared.activateSession(sessionId: "test-session-123", hostToWorkerKey: key, workerToHostKey: key)
        let payload = "Sensitive Telemetry Payload".data(using: .utf8)!

        let envelope = try PairingManager.shared.encryptEnvelope(payload: payload)
        XCTAssertEqual(envelope.sessionId, "test-session-123")
        XCTAssertEqual(envelope.sequenceNum, 1)

        let decrypted = try PairingManager.shared.decryptEnvelope(envelope: envelope)
        XCTAssertEqual(String(data: decrypted, encoding: .utf8), "Sensitive Telemetry Payload")
    }

    func testConcurrentEncryptionSequenceMonotonicity() throws {
        let key = SymmetricKey(size: .bits256)
        PairingManager.shared.activateSession(sessionId: "test-concurrent-seq", hostToWorkerKey: key, workerToHostKey: key)

        let count = 100
        let group = DispatchGroup()
        let lock = NSLock()
        var sequenceNumbers = [Int64]()

        for i in 0..<count {
            group.enter()
            DispatchQueue.global().async {
                let payload = "Payload-\(i)".data(using: .utf8)!
                if let env = try? PairingManager.shared.encryptEnvelope(payload: payload) {
                    lock.lock()
                    sequenceNumbers.append(env.sequenceNum)
                    lock.unlock()
                }
                group.leave()
            }
        }

        group.wait()

        XCTAssertEqual(sequenceNumbers.count, count)
        let uniqueSeq = Set(sequenceNumbers)
        XCTAssertEqual(uniqueSeq.count, count, "All sequence numbers must be strictly unique")
        XCTAssertEqual(sequenceNumbers.sorted(), Array(1...Int64(count)), "Sequence numbers must span exactly 1 to \(count) with no gaps or duplicates")
    }

    func testDirectionalKeySeparationAndCrossDecryptionRejection() throws {
        let hostDeviceId = "swarmx-host"
        let workerDeviceId = "test-worker-directional"

        // Host & Worker key agreement
        let hostPrivateKey = Curve25519.KeyAgreement.PrivateKey()
        let hostPublicKeyHex = hostPrivateKey.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined()

        let (workerPubHex, _) = PairingManager.shared.generateEphemeralKeypair()
        _ = try PairingManager.shared.computeSharedSecretAndSas(
            hostPublicKeyHex: hostPublicKeyHex,
            hostDeviceId: hostDeviceId,
            workerDeviceId: workerDeviceId
        )

        guard let workerPubData = Data(hexString: workerPubHex),
              let workerPublicKey = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: workerPubData) else {
            XCTFail("Failed to reconstruct worker public key")
            return
        }

        let hostSharedSecret = try hostPrivateKey.sharedSecretFromKeyAgreement(with: workerPublicKey)
        let hostToWorkerKey = PairingManager.deriveSessionKey(
            sharedSecret: hostSharedSecret,
            salt: PairingManager.shared.salt,
            contextInfo: "swarmx-host-to-worker-v1"
        )
        let workerToHostKey = PairingManager.deriveSessionKey(
            sharedSecret: hostSharedSecret,
            salt: PairingManager.shared.salt,
            contextInfo: "swarmx-worker-to-host-v1"
        )

        // 1. Worker encrypts telemetry for host
        PairingManager.shared.activateSession(
            sessionId: "session-dir-99",
            hostToWorkerKey: hostToWorkerKey,
            workerToHostKey: workerToHostKey
        )
        let workerTelemetry = "telemetry_data_123".data(using: .utf8)!
        let workerEnvelope = try PairingManager.shared.encryptEnvelope(payload: workerTelemetry)

        // Host decrypts with workerToHostKey
        let nonce = try AES.GCM.Nonce(data: Data(base64Encoded: workerEnvelope.ivNonce)!)
        let sealedBox = try AES.GCM.SealedBox(
            nonce: nonce,
            ciphertext: Data(base64Encoded: workerEnvelope.ciphertext)!,
            tag: Data(base64Encoded: workerEnvelope.authTag)!
        )
        let aad = "\(workerEnvelope.sessionId):\(workerEnvelope.sequenceNum)".data(using: .utf8)!
        let hostDecrypted = try AES.GCM.open(sealedBox, using: workerToHostKey, authenticating: aad)
        XCTAssertEqual(String(data: hostDecrypted, encoding: .utf8), "telemetry_data_123")

        // 2. Cross-direction rejection: Host attempting to decrypt workerEnvelope with hostToWorkerKey MUST fail
        XCTAssertThrowsError(try AES.GCM.open(sealedBox, using: hostToWorkerKey, authenticating: aad))
    }

    func testWorkerCliOptionsParsing() {
        // 1. Default fallback
        let defaultOpts = WorkerCliOptions.parse(arguments: ["swarmx-worker", "--connect"])
        XCTAssertTrue(defaultOpts.shouldConnect)
        XCTAssertEqual(defaultOpts.host, "127.0.0.1")
        XCTAssertEqual(defaultOpts.port, 50051)
        XCTAssertEqual(defaultOpts.targetUrl?.absoluteString, "ws://127.0.0.1:50051")

        // 2. Custom host IP
        let customHostOpts = WorkerCliOptions.parse(arguments: ["swarmx-worker", "--connect", "--host", "192.168.1.120"])
        XCTAssertTrue(customHostOpts.shouldConnect)
        XCTAssertEqual(customHostOpts.host, "192.168.1.120")
        XCTAssertEqual(customHostOpts.port, 50051)
        XCTAssertEqual(customHostOpts.targetUrl?.absoluteString, "ws://192.168.1.120:50051")

        // 3. Custom host:port
        let customHostPortOpts = WorkerCliOptions.parse(arguments: ["swarmx-worker", "--connect", "--host", "10.0.0.42:50051"])
        XCTAssertEqual(customHostPortOpts.host, "10.0.0.42")
        XCTAssertEqual(customHostPortOpts.port, 50051)

        // 4. WebSocket URL string
        let wsUrlOpts = WorkerCliOptions.parse(arguments: ["swarmx-worker", "--connect", "--host", "ws://192.168.1.200:50051"])
        XCTAssertEqual(wsUrlOpts.host, "192.168.1.200")
        XCTAssertEqual(wsUrlOpts.port, 50051)

        // 5. Without --connect
        let noConnectOpts = WorkerCliOptions.parse(arguments: ["swarmx-worker", "--host", "192.168.1.50"])
        XCTAssertFalse(noConnectOpts.shouldConnect)
    }

    func testDiscoveryStateMachineLifecycle() {
        let sm = DiscoveryStateMachine(defaultHostUrl: "ws://127.0.0.1:50051")

        // 1. Initial service discovery triggers connection
        let action1 = sm.handleEvent(.serviceFound(name: "SwarmX Host", endpointDescription: "192.168.1.100:50051"))
        XCTAssertEqual(action1, .connectToDiscovered(endpointDescription: "192.168.1.100:50051"))
        XCTAssertTrue(sm.isConnected)

        // 2. Duplicate service discovery is deduplicated without reconnecting
        let action2 = sm.handleEvent(.serviceFound(name: "SwarmX Host", endpointDescription: "192.168.1.100:50051"))
        XCTAssertEqual(action2, .none)

        // 3. Service disappearance
        let action3 = sm.handleEvent(.serviceLost(name: "SwarmX Host"))
        XCTAssertEqual(action3, .none) // Still marked connected
        XCTAssertNil(sm.activeServices["SwarmX Host"])

        // 4. Reset & Timeout fallback to default
        let sm2 = DiscoveryStateMachine(defaultHostUrl: "ws://127.0.0.1:50051")
        let action4 = sm2.handleEvent(.timeoutElapsed)
        XCTAssertEqual(action4, .fallbackToDefault(url: "ws://127.0.0.1:50051"))
        XCTAssertTrue(sm2.isFallbackTriggered)

        // Duplicate timeout does not trigger redundant fallback
        let action5 = sm2.handleEvent(.timeoutElapsed)
        XCTAssertEqual(action5, .none)
    }

    func testNativeBoxBlurKernel() {
        // 1. 4x4 RGBA solid image blur (radius 1) must preserve solid values exactly
        var solidRgba = Data(count: 4 * 4 * 4)
        for i in 0..<16 {
            solidRgba[i * 4 + 0] = 100 // R
            solidRgba[i * 4 + 1] = 150 // G
            solidRgba[i * 4 + 2] = 200 // B
            solidRgba[i * 4 + 3] = 255 // A
        }

        let blurredSolid = ImageProcessingKernel.applyBoxBlur(
            input: solidRgba,
            width: 4,
            height: 4,
            channels: 4,
            radius: 1
        )
        XCTAssertEqual(blurredSolid.count, solidRgba.count)
        for i in 0..<16 {
            XCTAssertEqual(blurredSolid[i * 4 + 0], 100)
            XCTAssertEqual(blurredSolid[i * 4 + 1], 150)
            XCTAssertEqual(blurredSolid[i * 4 + 2], 200)
            XCTAssertEqual(blurredSolid[i * 4 + 3], 255)
        }

        // 2. Determinism test: Executing twice yields 100% identical byte stream
        let kernel = ImageProcessingKernel.shared
        let payload = TaskPayload(
            taskId: "test-task-boxblur-1",
            attemptNumber: 1,
            computationDescriptor: "{\"kernelId\":\"image_filter_box_blur_v1\",\"radius\":2,\"width\":4,\"height\":4,\"channels\":4}",
            inputRef: "inline",
            inputData: solidRgba.base64EncodedString(),
            itemCount: 1
        )

        let result1 = kernel.processTask(payload: payload)
        let result2 = kernel.processTask(payload: payload)
        XCTAssertEqual(result1.status, "COMPLETED")
        XCTAssertEqual(result1.outputData, result2.outputData)
        XCTAssertEqual(result1.outputData, solidRgba.base64EncodedString())

        // 3. Radius 0 is identity
        let radius0 = ImageProcessingKernel.applyBoxBlur(input: solidRgba, width: 4, height: 4, channels: 4, radius: 0)
        XCTAssertEqual(radius0, solidRgba)

        // 4. Malformed/empty data resilience
        let empty = ImageProcessingKernel.applyBoxBlur(input: Data(), width: 0, height: 0, channels: 4, radius: 2)
        XCTAssertEqual(empty, Data())
    }

    func testNativeBoxBlurBenchmarkCalibration() {
        let resolutions = [(64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)]
        for (w, h) in resolutions {
            let totalBytes = w * h * 4
            var sample = Data(count: totalBytes)
            for i in 0..<min(1000, totalBytes) {
                sample[i] = UInt8(i % 256)
            }

            let start = DispatchTime.now()
            let out = ImageProcessingKernel.applyBoxBlur(input: sample, width: w, height: h, channels: 4, radius: 2)
            let elapsedNs = DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds
            let elapsedMs = Double(elapsedNs) / 1_000_000.0
            let mbPerSec = (Double(totalBytes) / (1024.0 * 1024.0)) / (elapsedMs / 1000.0)

            XCTAssertEqual(out.count, sample.count)
            XCTAssertGreaterThan(mbPerSec, 1.0)
        }
    }

    func testNativeGaussianBlurKernel() {
        let (w, h) = (16, 16)
        let sample = Data(repeating: 120, count: w * h * 4)
        let payload = TaskPayload(
            taskId: "t-gauss-01",
            attemptNumber: 1,
            computationDescriptor: "image_filter_gaussian_blur_v1",
            inputRef: "ref",
            inputData: sample.base64EncodedString(),
            itemCount: 1
        )

        let res = ImageProcessingKernel.shared.processTask(payload: payload)
        XCTAssertEqual(res.status, "COMPLETED")
        guard let outData = Data(base64Encoded: res.outputData) else {
            XCTFail("Failed to decode output")
            return
        }
        XCTAssertEqual(outData.count, sample.count)
        XCTAssertEqual(outData[0], 120) // Uniform field preserves mean
    }

    func testNativeMatrixMultiplyKernel() {
        // Two 2x2 float matrices: A = [[1, 2], [3, 4]], B = [[5, 6], [7, 8]]
        // C = A * B = [[19, 22], [43, 50]]
        let a: [Float] = [1.0, 2.0, 3.0, 4.0]
        let b: [Float] = [5.0, 6.0, 7.0, 8.0]
        var inputFloats = a + b
        let inData = Data(bytes: &inputFloats, count: inputFloats.count * 4)

        let payload = TaskPayload(
            taskId: "t-gemm-01",
            attemptNumber: 1,
            computationDescriptor: "matrix_multiply_v1",
            inputRef: "ref",
            inputData: inData.base64EncodedString(),
            itemCount: 1
        )

        let res = ImageProcessingKernel.shared.processTask(payload: payload)
        XCTAssertEqual(res.status, "COMPLETED")
        guard let outData = Data(base64Encoded: res.outputData) else {
            XCTFail("Failed to decode output")
            return
        }

        var resultFloats = [Float](repeating: 0, count: 4)
        outData.withUnsafeBytes { ptr in
            let fPtr = ptr.bindMemory(to: Float.self)
            for i in 0..<4 {
                resultFloats[i] = fPtr[i]
            }
        }

        XCTAssertEqual(resultFloats[0], 19.0, accuracy: 0.001)
        XCTAssertEqual(resultFloats[1], 22.0, accuracy: 0.001)
        XCTAssertEqual(resultFloats[2], 43.0, accuracy: 0.001)
        XCTAssertEqual(resultFloats[3], 50.0, accuracy: 0.001)
    }
}

private extension Data {
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
