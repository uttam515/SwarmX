# SwarmX Worker — Windows Foundation (.NET / C#)

> **Phase 0 Status**: Foundation Stub & Interface Contract.  
> Target: .NET 8 / C# Native Windows Service & System Tray Application.

## Overview

The Windows worker client mirrors the native architecture of the macOS Swift worker, leveraging native Windows APIs for first-class sandboxing and resource management in later phases.

## Interface Contract & Architecture

1. **Discovery & Pairing**:
   - mDNS discovery via Windows `DnssdServiceWatcher` or `Zeroconf`.
   - ECDH Key Exchange (`System.Security.Cryptography.ECDiffieHellmanCng`).
   - HKDF derivation of 4-digit Short Authentication String (SAS) matching `proto/swarmx/v1/pairing.proto`.
   - Glance-and-tap confirmation dialog on incoming connection request.

2. **Telemetry & Capability Profiling**:
   - CPU and memory metrics via `System.Diagnostics.PerformanceCounter` and `GlobalMemoryStatusEx`.
   - Battery and power status via `SystemInformation.PowerStatus`.
   - Thermal telemetry via WMI (`root\wmi` -> `MSAcpi_ThermalZoneTemperature`).
   - Reporting versioned `CapabilityProfile` (`capability_schema_version = 1`).

3. **Sandboxed Execution (Phase 1+)**:
   - Windows Job Objects API (`SetInformationJobObject`, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) with CPU rate control and memory limits.
   - AppContainer isolation for untrusted workload containment.
