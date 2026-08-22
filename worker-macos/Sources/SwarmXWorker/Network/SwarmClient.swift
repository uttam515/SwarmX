import Foundation
import Network

public class SwarmClient {
    public static let shared = SwarmClient()

    private var connection: NWConnection?
    private var browser: NWBrowser?
    private let queue = DispatchQueue(label: "org.swarmx.worker.network", qos: .userInitiated)
    private var timer: Timer?
    private var discoveryTimer: Timer?
    private var isConnected: Bool = false
    private var isBrowsing: Bool = false
    private var isExplicitHostMode: Bool = false

    public var deviceId: String {
        get {
            if let stored = UserDefaults.standard.string(forKey: "SwarmXCanonicalDeviceId") {
                return stored
            }
            let newId = "macos-worker-" + UUID().uuidString.prefix(8)
            UserDefaults.standard.set(newId, forKey: "SwarmXCanonicalDeviceId")
            return newId
        }
        set {
            UserDefaults.standard.set(newValue, forKey: "SwarmXCanonicalDeviceId")
        }
    }
    public var deviceName: String = Host.current().localizedName ?? "MacBook Pro"
    public var hostUrl: URL = URL(string: "ws://127.0.0.1:50051")!

    public init() {}

    /**
     * Autonomous Host Discovery via Bonjour / mDNS (_swarmx._tcp)
     * Discovers Core Coordinator on the local network/hotspot and connects automatically.
     */
    public func startAutoDiscoveryAndConnect() {
        guard !self.isBrowsing, !self.isConnected else { return }
        self.isBrowsing = true
        self.isExplicitHostMode = false
        print("🔍 Scanning for SwarmX Host Coordinator via Bonjour (_swarmx._tcp)...")

        let descriptor = NWBrowser.Descriptor.bonjour(type: "_swarmx._tcp", domain: "local.")
        let parameters = NWParameters()
        parameters.includePeerToPeer = true

        let b = NWBrowser(for: descriptor, using: parameters)
        self.browser = b

        b.stateUpdateHandler = { state in
            switch state {
            case .ready:
                print("📡 Bonjour Host Discovery is active.")
            case .failed(let error):
                print("⚠️ Bonjour Host Discovery failed: \(error.localizedDescription)")
            default:
                break
            }
        }

        b.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self = self, self.isBrowsing, !self.isConnected else { return }
            if let firstMatch = results.first {
                print("🎯 Discovered SwarmX Host Coordinator: \(firstMatch.endpoint)")
                self.connect(to: firstMatch.endpoint)
            }
        }

        b.start(queue: self.queue)

        // Fallback: If Bonjour discovery doesn't resolve within 4 seconds, attempt default local host
        self.queue.asyncAfter(deadline: .now() + 4.0) { [weak self] in
            guard let self = self, self.isBrowsing, !self.isConnected else { return }
            print("ℹ️ Auto-discovery scanning. Attempting direct fallback connection to \(self.hostUrl)...")
            self.connect(hostUrl: self.hostUrl)
        }
    }

    public func stopDiscovery() {
        self.isBrowsing = false
        self.browser?.cancel()
        self.browser = nil
    }

    /**
     * Connect directly to an NWEndpoint (from Bonjour or explicit resolution)
     */
    public func connect(to endpoint: NWEndpoint) {
        self.disconnect(reconnect: false)
        print("🔗 Connecting to SwarmX Host at \(endpoint)...")
        self.initiateConnection(to: endpoint)
    }

    /**
     * Connect to a specific host URL (e.g. from CLI --host)
     */
    public func connect(hostUrl: URL? = nil) {
        self.disconnect(reconnect: false)
        self.isExplicitHostMode = true
        if let hostUrl = hostUrl {
            self.hostUrl = hostUrl
        }
        print("🔗 Connecting to SwarmX Host at \(self.hostUrl)...")
        let endpoint: NWEndpoint
        if let host = self.hostUrl.host, let port = self.hostUrl.port {
            endpoint = NWEndpoint.hostPort(
                host: NWEndpoint.Host(host),
                port: NWEndpoint.Port(integerLiteral: UInt16(port))
            )
        } else if let host = self.hostUrl.host {
            endpoint = NWEndpoint.hostPort(
                host: NWEndpoint.Host(host),
                port: NWEndpoint.Port(integerLiteral: 50051)
            )
        } else {
            endpoint = NWEndpoint.url(self.hostUrl)
        }
        self.initiateConnection(to: endpoint)
    }

    private func initiateConnection(to endpoint: NWEndpoint) {
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        wsOptions.maximumMessageSize = 256 * 1024 * 1024 // 256 MB symmetric headroom for high-res images and large GEMM matrices (up to 4096x4096)

        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)

        let conn = NWConnection(to: endpoint, using: parameters)
        self.connection = conn

        conn.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                self.isConnected = true
                self.stopDiscovery()
                print("✅ WebSocket connection established to SwarmX Host.")
                print("[LOCAL-WORKER] WEBSOCKET_CONNECTED")
                self.sendDiscoveryBeacon()
                self.listen()
                if PairingManager.shared.activeSessionId == nil {
                    self.startDiscoveryHeartbeat()
                }
            case .waiting(let error):
                print("⏳ WebSocket connecting (waiting for path): \(error.localizedDescription)")
            case .failed(let error):
                self.isConnected = false
                self.stopDiscoveryHeartbeat()
                print("❌ WebSocket connection failed: \(error.localizedDescription)")
                self.scheduleAutoReconnect()
            case .cancelled:
                self.isConnected = false
                self.stopDiscoveryHeartbeat()
                print("🔌 WebSocket disconnected from Host.")
                self.scheduleAutoReconnect()
            default:
                break
            }
        }

        conn.start(queue: self.queue)
    }

    private func scheduleAutoReconnect() {
        self.queue.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            guard let self = self, !self.isConnected else { return }
            print("🔄 Auto-reconnecting to SwarmX Coordinator...")
            if self.isExplicitHostMode {
                self.connect(hostUrl: self.hostUrl)
            } else {
                self.startAutoDiscoveryAndConnect()
            }
        }
    }

    private func startDiscoveryHeartbeat() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.discoveryTimer?.invalidate()
            self.discoveryTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
                guard let self = self, self.isConnected else { return }
                if PairingManager.shared.activeSessionId == nil {
                    self.sendDiscoveryBeacon()
                }
            }
        }
    }

    private func stopDiscoveryHeartbeat() {
        DispatchQueue.main.async { [weak self] in
            self?.discoveryTimer?.invalidate()
            self?.discoveryTimer = nil
        }
    }

    public func disconnect(reconnect: Bool = false) {
        self.stopDiscoveryHeartbeat()
        self.timer?.invalidate()
        self.timer = nil
        self.isConnected = false
        self.connection?.cancel()
        self.connection = nil
        if reconnect {
            self.scheduleAutoReconnect()
        }
    }

    private var isListening = false

    private func listen() {
        guard let connection = self.connection, self.isConnected else { return }
        guard !self.isListening else { return }
        self.isListening = true

        connection.receiveMessage { [weak self] content, context, isComplete, error in
            guard let self = self else { return }
            self.isListening = false

            if let error = error {
                print("⚠️ [WORKER] WebSocket receive error: \(error.localizedDescription)")
                if self.isConnected {
                    // Reschedule receive loop on network queue to recover from transient frame error
                    self.queue.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                        self?.listen()
                    }
                }
                return
            }

            if let data = content, let text = String(data: data, encoding: .utf8) {
                self.handleMessage(text: text)
            }

            if self.isConnected {
                self.listen()
            }
        }
    }

    private func send(json: [String: Any]) {
        guard let connection = self.connection else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: json),
              let string = String(data: data, encoding: .utf8) else { return }

        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "wsSend", metadata: [metadata])

        connection.send(content: string.data(using: .utf8), contentContext: context, isComplete: true, completion: .contentProcessed({ error in
            if let error = error {
                print("❌ Send error: \(error.localizedDescription)")
            }
        }))
    }

    public func sendDiscoveryBeacon() {
        let profile = CapabilityProfile(deviceId: self.deviceId, deviceName: self.deviceName)
        let profileData = try! JSONEncoder().encode(profile)
        let profileDict = try! JSONSerialization.jsonObject(with: profileData) as! [String: Any]

        let msg: [String: Any] = [
            "type": "DISCOVERY_BEACON",
            "deviceId": self.deviceId,
            "deviceName": self.deviceName,
            "capabilityProfile": profileDict
        ]
        self.send(json: msg)
        print("[LOCAL-WORKER] DISCOVERY_SENT")
    }

    private var isPairingInProgress = false

    public func initiatePairing(initiationId: String, hostPublicKeyHex: String, hostDeviceId: String = "swarmx-host") {
        if self.isPairingInProgress {
            print("⚠️ Pairing request already in progress, ignoring duplicate.")
            return
        }
        self.isPairingInProgress = true

        let (pubKeyHex, saltHex) = PairingManager.shared.generateEphemeralKeypair()
        do {
            let sasCode = try PairingManager.shared.computeSharedSecretAndSas(
                hostPublicKeyHex: hostPublicKeyHex,
                hostDeviceId: hostDeviceId,
                workerDeviceId: self.deviceId
            )
            print("\n=======================================================")
            print("🔔 [PAIRING REQUEST] Host '\(hostDeviceId)' wants to connect!")
            print("👉 VERIFY COMPARISON CODE: [ \(sasCode) ]")
            print("=======================================================")
            print("[LOCAL-WORKER] PAIRING_REQUEST_RECEIVED")

            let autoPair = ProcessInfo.processInfo.environment["SWARMX_AUTO_PAIR"] == "1"
            if autoPair {
                print("✅ Auto-pairing enabled (SWARMX_AUTO_PAIR=1). Confirming connection from host '\(hostDeviceId)'...")
                print("[LOCAL-WORKER] PAIRING_AUTO_CONFIRMED")
                self.isPairingInProgress = false
                let profile = CapabilityProfile(deviceId: self.deviceId, deviceName: self.deviceName)
                let profileData = try! JSONEncoder().encode(profile)
                let profileDict = try! JSONSerialization.jsonObject(with: profileData) as! [String: Any]

                let msg: [String: Any] = [
                    "type": "PAIRING_CONFIRM",
                    "initiationId": initiationId,
                    "workerDeviceId": self.deviceId,
                    "workerDeviceName": self.deviceName,
                    "workerPublicKeyHex": pubKeyHex,
                    "workerSaltHex": saltHex,
                    "confirmedSasCode": sasCode,
                    "capabilityProfile": profileDict
                ]
                self.send(json: msg)
                print("[LOCAL-WORKER] PAIRING_CONFIRMED")
                return
            }

            DispatchQueue.global(qos: .userInteractive).async { [weak self] in
                guard let self = self else { return }
                print("👉 Allow connection from host '\(hostDeviceId)'? [y/N]: ", terminator: "")
                fflush(stdout)

                let response = readLine()?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "n"
                self.isPairingInProgress = false

                if response == "y" || response == "yes" {
                    print("✅ Pairing confirmed by user. Establishing secure session...")
                    let profile = CapabilityProfile(deviceId: self.deviceId, deviceName: self.deviceName)
                    let profileData = try! JSONEncoder().encode(profile)
                    let profileDict = try! JSONSerialization.jsonObject(with: profileData) as! [String: Any]

                    let msg: [String: Any] = [
                        "type": "PAIRING_CONFIRM",
                        "initiationId": initiationId,
                        "workerDeviceId": self.deviceId,
                        "workerDeviceName": self.deviceName,
                        "workerPublicKeyHex": pubKeyHex,
                        "workerSaltHex": saltHex,
                        "confirmedSasCode": sasCode,
                        "capabilityProfile": profileDict
                    ]
                    self.send(json: msg)
                    print("[LOCAL-WORKER] PAIRING_CONFIRMED")
                } else {
                    print("❌ Pairing rejected by user.")
                    let msg: [String: Any] = [
                        "type": "PAIRING_REJECT",
                        "workerDeviceId": self.deviceId,
                        "reason": "USER_REJECTED"
                    ]
                    self.send(json: msg)
                }
            }
        } catch {
            self.isPairingInProgress = false
            print("❌ Failed to compute SAS: \(error)")
        }
    }

    private func handleMessage(text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        if let error = json["error"] as? String {
            print("❌ Error from Host: \(error)")
            if error.contains("Unknown session ID") || error.contains("No active encrypted session") {
                print("⚠️ Active session invalidated by host. Halting telemetry and awaiting re-pairing.")
                DispatchQueue.main.async { [weak self] in
                    guard let self = self else { return }
                    self.timer?.invalidate()
                    self.timer = nil
                    PairingManager.shared.revokeTrust()
                    self.sendDiscoveryBeacon()
                }
            }
            return
        }

        guard let type = json["type"] as? String else { return }

        switch type {
        case "DISCOVERY_ACK":
            print("✅ Discovery acknowledged by Host.")

        case "PAIRING_REQUEST":
            if let initiationId = json["initiationId"] as? String,
               let hostPubKey = json["hostPublicKeyHex"] as? String {
                let hostDeviceId = json["hostDeviceId"] as? String ?? "swarmx-host"
                self.initiatePairing(initiationId: initiationId, hostPublicKeyHex: hostPubKey, hostDeviceId: hostDeviceId)
            }

        case "PAIRING_SUCCESS":
            if let sessionId = json["sessionId"] as? String {
                self.stopDiscoveryHeartbeat()
                PairingManager.shared.activateSession(sessionId: sessionId)
                print("🔒 Secure session established (Session ID: \(sessionId)).")
                print("[LOCAL-WORKER] REGISTERED")
                self.sendTelemetryReport()
                print("[LOCAL-WORKER] READY")
                self.startTelemetryReporting()
            }

        case "ENCRYPTED_TELEMETRY_ACK":
            if let envDict = json["envelope"] as? [String: Any],
               let envData = try? JSONSerialization.data(withJSONObject: envDict),
               let envelope = try? JSONDecoder().decode(EncryptedEnvelope.self, from: envData) {
                _ = try? PairingManager.shared.decryptEnvelope(envelope: envelope)
            }

        case "EXECUTE_TASK":
            if let envDict = json["envelope"] as? [String: Any],
               let envData = try? JSONSerialization.data(withJSONObject: envDict) {
                print("[WORKER] EXECUTE_TASK received (envelope bytes: \(envData.count))")
                let taskId = (json["taskId"] as? String) ?? "unknown-task"
                self.sendTaskStage(taskId: taskId, stage: "DECRYPTING")
                
                if let envelope = try? JSONDecoder().decode(EncryptedEnvelope.self, from: envData),
                   let decryptedData = try? PairingManager.shared.decryptEnvelope(envelope: envelope),
                   let taskPayload = try? JSONDecoder().decode(TaskPayload.self, from: decryptedData) {
                    
                    print("[WORKER] Payload decrypted and decoded")
                    self.sendTaskStage(taskId: taskPayload.taskId, stage: "EXECUTING")
                    
                    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                        guard let self = self else { return }
                        let resultPayload = ImageProcessingKernel.shared.processTask(payload: taskPayload)
                        guard let resultData = try? JSONEncoder().encode(resultPayload) else { return }
                        
                        self.sendTaskStage(taskId: taskPayload.taskId, stage: "TRANSMITTING")
                        
                        // Strictly serialize encryption and wire transmission on the dedicated network queue
                        self.queue.async {
                            guard let resultEnvelope = try? PairingManager.shared.encryptEnvelope(payload: resultData) else { return }
                            
                            let envDict: [String: Any] = [
                                "sessionId": resultEnvelope.sessionId,
                                "sequenceNum": resultEnvelope.sequenceNum,
                                "ivNonce": resultEnvelope.ivNonce,
                                "ciphertext": resultEnvelope.ciphertext,
                                "authTag": resultEnvelope.authTag
                            ]
                            let msg: [String: Any] = [
                                "type": "TASK_RESULT",
                                "workerDeviceId": self.deviceId,
                                "taskId": taskPayload.taskId,
                                "envelope": envDict
                            ]
                            self.send(json: msg)
                            print("[WORKER] TASK_RESULT encrypted and transmitted")
                        }
                    }
                } else {
                    print("⚠️ [WORKER] Failed to decrypt or decode EXECUTE_TASK envelope")
                    self.sendTaskStage(taskId: taskId, stage: "FAILED")
                }
            }

        case "REVOKE_TRUST":
            print("⚠️ Trust revoked by host. Session terminated.")
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.timer?.invalidate()
                self.timer = nil
                PairingManager.shared.revokeTrust()
                self.sendDiscoveryBeacon()
            }

        default:
            print("ℹ️ Message received: \(type)")
        }
    }

    private func startTelemetryReporting() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.timer?.invalidate()
            self.timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
                self?.sendTelemetryReport()
            }
        }
    }

    public func sendTelemetryReport() {
        self.queue.async { [weak self] in
            guard let self = self else { return }
            guard PairingManager.shared.activeSessionId != nil else { return }
            let telemetry = TelemetryProvider.shared.collectTelemetry(deviceId: self.deviceId)
            guard let telemetryData = try? JSONEncoder().encode(telemetry),
                  let envelope = try? PairingManager.shared.encryptEnvelope(payload: telemetryData) else { return }

            let envData = try! JSONEncoder().encode(envelope)
            let envDict = try! JSONSerialization.jsonObject(with: envData) as! [String: Any]

            let msg: [String: Any] = [
                "type": "ENCRYPTED_TELEMETRY",
                "deviceId": self.deviceId,
                "envelope": envDict
            ]
            self.send(json: msg)
        }
    }

    public func sendTaskStage(taskId: String, stage: String, details: [String: Any]? = nil) {
        self.queue.async { [weak self] in
            guard let self = self else { return }
            var msg: [String: Any] = [
                "type": "TASK_STAGE",
                "workerDeviceId": self.deviceId,
                "taskId": taskId,
                "stage": stage
            ]
            if let details = details {
                msg["details"] = details
            }
            self.send(json: msg)
        }
    }

    public func revoke() {
        let msg: [String: Any] = [
            "type": "REVOKE_TRUST",
            "deviceId": self.deviceId
        ]
        self.send(json: msg)
        PairingManager.shared.revokeTrust()
        self.disconnect()
        print("🗑️ Trust revoked and connection terminated.")
    }
}
