import Foundation
import Network

/**
 * Minimal Standalone Transport Probe (Phase D)
 * Tests raw WebSocket communication against Core without any crypto/pairing/telemetry overhead.
 */
class MinimalTransportProbe {
    private var connection: NWConnection?
    private let queue = DispatchQueue(label: "probe.ws.queue")
    private let semaphore = DispatchSemaphore(value: 0)
    private var success = false

    func test(target: String) -> Bool {
        print("\n=======================================================")
        print("🧪 PROBE TEST: Connecting to \(target)...")
        print("=======================================================")

        guard let url = URL(string: target) else {
            print("❌ Invalid URL: \(target)")
            return false
        }

        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true

        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = true
        parameters.prohibitExpensivePaths = false
        parameters.prohibitConstrainedPaths = false
        parameters.allowLocalEndpointReuse = true
        parameters.serviceClass = .responsiveData
        parameters.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)

        let endpoint = NWEndpoint.url(url)
        let conn = NWConnection(to: endpoint, using: parameters)
        self.connection = conn

        conn.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .setup:
                print("  [State: SETUP]")
            case .preparing:
                print("  [State: PREPARING]")
            case .waiting(let error):
                print("  [State: WAITING] \(error.localizedDescription) (resolving network path...)")
            case .ready:
                print("  [State: READY] ✅ TCP + WebSocket Handshake Established!")
                self.sendProbeMessage()
                self.receiveProbeResponse()
            case .failed(let error):
                print("  [State: FAILED] ❌ Connection failed: \(error.localizedDescription)")
                self.semaphore.signal()
            case .cancelled:
                print("  [State: CANCELLED] 🔌 Connection closed.")
            @unknown default:
                break
            }
        }

        conn.start(queue: queue)
        _ = semaphore.wait(timeout: .now() + 5.0)
        conn.cancel()
        return success
    }

    private func sendProbeMessage() {
        guard let conn = connection else { return }
        let pingJson = "{\"type\":\"DISCOVERY_BEACON\",\"deviceId\":\"probe-test-node\",\"deviceName\":\"Probe Worker\"}"
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "probeSend", metadata: [metadata])

        conn.send(content: pingJson.data(using: .utf8), contentContext: context, isComplete: true, completion: .contentProcessed({ error in
            if let error = error {
                print("  ❌ Probe Send Error: \(error.localizedDescription)")
            } else {
                print("  📤 Sent 1 probe text frame (DISCOVERY_BEACON)")
            }
        }))
    }

    private func receiveProbeResponse() {
        guard let conn = connection else { return }
        conn.receiveMessage { [weak self] content, context, isComplete, error in
            guard let self = self else { return }
            if let error = error {
                print("  ❌ Probe Receive Error: \(error.localizedDescription)")
            } else if let data = content, let text = String(data: data, encoding: .utf8) {
                print("  📥 Received response from Core: \(text)")
                self.success = true
            }
            self.semaphore.signal()
        }
    }
}

let target = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "ws://127.0.0.1:50051"
let probe = MinimalTransportProbe()
let passed = probe.test(target: target)
print("🏁 PROBE RESULT for \(target): \(passed ? "✅ SUCCESS" : "❌ FAILED")\n")
exit(passed ? 0 : 1)
