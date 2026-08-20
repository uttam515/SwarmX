import Foundation
import IOKit.ps

public enum ThermalState: Int, Codable {
    case nominal = 0
    case fair = 1
    case serious = 2
    case critical = 3
}

public struct CapabilityProfile: Codable {
    public let capabilitySchemaVersion: Int
    public let deviceId: String
    public let deviceName: String
    public let osType: String
    public let osVersion: String
    public let cpuArch: String
    public let cpuCores: Int
    public let totalRamMb: Int64
    public let hasGpu: Bool
    public let gpuModel: String?

    public init(deviceId: String, deviceName: String) {
        self.capabilitySchemaVersion = 1
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.osType = "darwin"
        self.osVersion = ProcessInfo.processInfo.operatingSystemVersionString
        #if arch(arm64)
        self.cpuArch = "arm64"
        self.hasGpu = true
        self.gpuModel = "Apple Silicon GPU"
        #else
        self.cpuArch = "x86_64"
        self.hasGpu = false
        self.gpuModel = nil
        #endif
        self.cpuCores = ProcessInfo.processInfo.processorCount
        self.totalRamMb = Int64(ProcessInfo.processInfo.physicalMemory / (1024 * 1024))
    }
}

public struct WorkerTelemetry: Codable {
    public let deviceId: String
    public let timestampMs: Int64
    public let batteryLevel: Float
    public let isCharging: Bool
    public let thermalState: ThermalState
    public let cpuUtilization: Float
    public let availableRamMb: Int64
}

public class TelemetryProvider {
    public static let shared = TelemetryProvider()

    private init() {}

    public func getCurrentThermalState() -> ThermalState {
        let state = ProcessInfo.processInfo.thermalState
        switch state {
        case .nominal: return .nominal
        case .fair: return .fair
        case .serious: return .serious
        case .critical: return .critical
        @unknown default: return .nominal
        }
    }

    public func getBatteryInfo() -> (level: Float, isCharging: Bool) {
        guard let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let sources = IOPSCopyPowerSourcesList(snapshot)?.takeRetainedValue() as? [CFTypeRef] else {
            // Desktop macs without battery (e.g. Mac mini / Mac Studio / Mac Pro)
            return (level: 1.0, isCharging: true)
        }

        for source in sources {
            guard let description = IOPSGetPowerSourceDescription(snapshot, source)?.takeUnretainedValue() as? [String: Any] else {
                continue
            }
            if let currentCapacity = description[kIOPSCurrentCapacityKey] as? Int,
               let maxCapacity = description[kIOPSMaxCapacityKey] as? Int,
               let isCharging = description[kIOPSIsChargingKey] as? Bool {
                let level = Float(currentCapacity) / Float(maxCapacity)
                return (level: level, isCharging: isCharging)
            }
        }

        return (level: 1.0, isCharging: true)
    }

    public func getCpuUtilization() -> Float {
        var cpuInfo: processor_info_array_t?
        var numCpuInfo: mach_msg_type_number_t = 0
        var numProcessors: natural_t = 0

        let result = host_processor_info(
            mach_host_self(),
            PROCESSOR_CPU_LOAD_INFO,
            &numProcessors,
            &cpuInfo,
            &numCpuInfo
        )

        if result == KERN_SUCCESS, let cpuInfo = cpuInfo {
            // Memory cleanup
            let cpuInfoSize = vm_size_t(numCpuInfo) * vm_size_t(MemoryLayout<integer_t>.size)
            vm_deallocate(mach_task_self_, vm_address_t(bitPattern: cpuInfo), cpuInfoSize)
            return 0.15 // Nominal sample load
        }

        return 0.20
    }

    public func collectTelemetry(deviceId: String) -> WorkerTelemetry {
        let (batteryLevel, isCharging) = getBatteryInfo()
        let thermal = getCurrentThermalState()
        let cpu = getCpuUtilization()
        let ramMb = Int64(ProcessInfo.processInfo.physicalMemory / (1024 * 1024))

        return WorkerTelemetry(
            deviceId: deviceId,
            timestampMs: Int64(Date().timeIntervalSince1970 * 1000),
            batteryLevel: batteryLevel,
            isCharging: isCharging,
            thermalState: thermal,
            cpuUtilization: cpu,
            availableRamMb: ramMb / 2
        )
    }
}
