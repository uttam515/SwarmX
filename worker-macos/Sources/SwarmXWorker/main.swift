import Foundation

print("---------------------------------------------------------")
print("🍏 SwarmX Native macOS Worker (Phase 0 Foundations)")
print("---------------------------------------------------------")

let options = WorkerCliOptions.parse(arguments: CommandLine.arguments)

let client = SwarmClient.shared
let telemetry = TelemetryProvider.shared.collectTelemetry(deviceId: client.deviceId)
let profile = CapabilityProfile(deviceId: client.deviceId, deviceName: client.deviceName)

print("💻 Hardware Profile:")
print("   - Device Name: \(profile.deviceName)")
print("   - Architecture: \(profile.cpuArch)")
print("   - CPU Cores: \(profile.cpuCores)")
print("   - Total RAM: \(profile.totalRamMb) MB")
print("   - GPU: \(profile.hasGpu ? (profile.gpuModel ?? "Available") : "None")")
print("   - OS Version: \(profile.osVersion)")
print("⚡ Telemetry Status:")
print("   - Battery: \(Int(telemetry.batteryLevel * 100))% (\(telemetry.isCharging ? "Charging" : "Discharging"))")
print("   - Thermal State: \(telemetry.thermalState)")
print("   - CPU Load: \(Int(telemetry.cpuUtilization * 100))%")

if options.isExplicitHost {
    if let targetUrl = options.targetUrl {
        client.connect(hostUrl: targetUrl)
    } else {
        print("❌ Invalid target host URL.")
    }
} else {
    // Default seamless UX: Automatic Bonjour Host Discovery
    client.startAutoDiscoveryAndConnect()
}

// Keep runloop alive
RunLoop.main.run()
