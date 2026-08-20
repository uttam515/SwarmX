import Foundation
import Network

print("🔍 Starting NWBrowser scan for _swarmx._tcp...")
let descriptor = NWBrowser.Descriptor.bonjour(type: "_swarmx._tcp", domain: "local.")
let parameters = NWParameters()
parameters.includePeerToPeer = true

let browser = NWBrowser(for: descriptor, using: parameters)
let queue = DispatchQueue(label: "bonjour.browser")

browser.stateUpdateHandler = { state in
    print("BROWSER STATE: \(state)")
}

browser.browseResultsChangedHandler = { results, changes in
    print("📢 DISCOVERED \(results.count) RESULT(S):")
    for res in results {
        print("  👉 Service Endpoint: \(res.endpoint)")
        if case let .bonjour(txt) = res.metadata {
            print("     TXT Metadata: \(txt.dictionary)")
        }
    }
}

browser.start(queue: queue)
RunLoop.main.run(until: Date(timeIntervalSinceNow: 2.0))
browser.cancel()
