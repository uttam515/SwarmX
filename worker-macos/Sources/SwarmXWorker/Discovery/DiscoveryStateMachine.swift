import Foundation
import Network

public enum DiscoveryEvent: Equatable {
    case serviceFound(name: String, endpointDescription: String)
    case serviceLost(name: String)
    case timeoutElapsed
    case reset
}

public enum DiscoveryAction: Equatable {
    case none
    case connectToDiscovered(endpointDescription: String)
    case fallbackToDefault(url: String)
    case retryDiscovery
}

public class DiscoveryStateMachine {
    public private(set) var activeServices: [String: String] = [:] // name -> endpointDescription
    public private(set) var isConnected: Bool = false
    public private(set) var isFallbackTriggered: Bool = false
    public let defaultHostUrl: String

    public init(defaultHostUrl: String = "ws://127.0.0.1:50051") {
        self.defaultHostUrl = defaultHostUrl
    }

    public func handleEvent(_ event: DiscoveryEvent) -> DiscoveryAction {
        switch event {
        case .serviceFound(let name, let endpointDescription):
            let isNew = activeServices[name] == nil
            activeServices[name] = endpointDescription
            
            if !isConnected {
                isConnected = true
                return .connectToDiscovered(endpointDescription: endpointDescription)
            }
            return .none

        case .serviceLost(let name):
            activeServices.removeValue(forKey: name)
            if activeServices.isEmpty && !isConnected {
                return .retryDiscovery
            }
            return .none

        case .timeoutElapsed:
            if !isConnected && !isFallbackTriggered {
                isFallbackTriggered = true
                return .fallbackToDefault(url: defaultHostUrl)
            }
            return .none

        case .reset:
            activeServices.removeAll()
            isConnected = false
            isFallbackTriggered = false
            return .retryDiscovery
        }
    }
}
