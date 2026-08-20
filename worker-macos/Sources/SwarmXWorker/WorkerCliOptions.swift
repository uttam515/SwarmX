import Foundation

public struct WorkerCliOptions {
    public let shouldConnect: Bool
    public let host: String
    public let port: Int
    public let isExplicitHost: Bool
    
    public var targetUrl: URL? {
        return URL(string: "ws://\(host):\(port)")
    }
    
    public static func parse(arguments: [String]) -> WorkerCliOptions {
        let shouldConnect = arguments.contains("--connect")
        var host = "127.0.0.1"
        var port = 50051
        var isExplicitHost = false
        
        if let hostIndex = arguments.firstIndex(of: "--host"), hostIndex + 1 < arguments.count {
            isExplicitHost = true
            let hostArg = arguments[hostIndex + 1].trimmingCharacters(in: .whitespacesAndNewlines)
            if hostArg.hasPrefix("ws://") || hostArg.hasPrefix("wss://") {
                if let parsedUrl = URL(string: hostArg), let parsedHost = parsedUrl.host {
                    host = parsedHost
                    if let parsedPort = parsedUrl.port {
                        port = parsedPort
                    }
                }
            } else if hostArg.contains(":") {
                let parts = hostArg.split(separator: ":")
                host = String(parts[0])
                if parts.count > 1, let p = Int(parts[1]) {
                    port = p
                }
            } else if !hostArg.isEmpty {
                host = hostArg
            }
        }
        
        return WorkerCliOptions(shouldConnect: shouldConnect, host: host, port: port, isExplicitHost: isExplicitHost)
    }
}
