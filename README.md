# SwarmX — Phase 0 (Foundations)

SwarmX is a local-network, opt-in, developer-facing distributed execution runtime. A host (the developer's primary machine) recruits nearby worker devices under explicit per-device consent, decomposes workloads into tasks, schedules them adaptively based on live worker telemetry, and aggregates validated results.

---

## Phase 0 Architecture Overview

```text
swarmx/
├── proto/                          # Shared Protocol Buffers schemas
│   └── swarmx/v1/
│       ├── task.proto              # DAG task schema, resources, state machine
│       ├── capability.proto        # Versioned capability profile & telemetry
│       ├── pairing.proto           # Bound ECDH SAS comparison & revocation
│       └── swarmx_service.proto    # Service RPCs & encrypted session framing
├── core/                           # SwarmX Host Daemon (Node.js/TypeScript)
│   ├── src/
│   │   ├── db/                     # SQLite TaskStore (WAL mode) + Watchdog Recovery
│   │   ├── worker_manager.ts       # Ingestion & binary eligibility gate
│   │   ├── pairing_service.ts      # ECDH (X25519) + SAS + AES-GCM framing
│   │   ├── transport_server.ts     # mDNS Bonjour discovery + WS transport + Watchdog
│   │   ├── ipc_server.ts           # Unix socket (/tmp/swarmx.sock, 0600 mode)
│   │   ├── result_validator.ts     # Validation abstraction (ExactMatch & Numeric)
│   │   ├── scheduler.ts            # IScheduler & DeterministicFifoScheduler
│   │   └── stubs/                  # Workload Pipeline stubs
│   └── test/                       # Mocha/Chai automated test suites (22 tests)
├── worker-macos/                   # Native macOS Desktop Worker (Swift / SwiftUI)
│   ├── Sources/SwarmXWorker/
│   │   ├── Telemetry/              # IOKit battery & ProcessInfo thermal sensors
│   │   ├── Pairing/                # CryptoKit X25519 + SAS + AES-GCM
│   │   ├── Network/                # SwarmClient LAN communication
│   │   └── Execution/              # Simulated execution stub
│   └── Tests/                      # XCTest suite (4 tests)
├── worker-windows/                 # Windows Worker foundation (.NET / C#)
│   └── README.md                   # Job Objects & WMI contract specification
└── vscode-extension/               # Thin VS Code Extension (TypeScript)
    ├── src/
    │   ├── core_ipc_client.ts      # Client connecting to /tmp/swarmx.sock
    │   ├── views/                  # TreeViews for Workers, Discovery, Tasks
    │   └── extension.ts            # Extension activation & command wiring
    └── package.json
```

---

## Real vs. Stubbed Matrix (Phase 0)

| Component | Status | Description in Phase 0 |
|---|---|---|
| **Task Store** | **REAL** | SQLite database in WAL mode with DAG cycle checking, diamond graph dependencies, atomic assignment, and complete state machine (`PENDING` -> `ASSIGNED` -> `RUNNING` -> `COMPLETED`/`ABANDONED`/`FAILED`). |
| **Crash & Lease Watchdog** | **REAL** | Startup crash recovery and active background watchdog interval (5s) in `TransportServer` recovering expired leases (`recoverExpiredLeases`) and worker disconnects (`recoverWorkerLoss`). Increments `retry_count`, logs reason to `attempt_history`, and transitions to `PENDING` (or `FAILED` if retries >= 3). |
| **Security & Pairing** | **REAL** | ECDH (X25519) key exchange + Short Authentication String (SAS, 4-digit glance-and-tap comparison code bound to handshake transcript via HKDF) + AES-256-GCM binary payload encryption. No plaintext leaks. |
| **Session Framing & Replay Protection** | **REAL** | Deterministic 96-bit nonces (4-byte salt + 8-byte monotonic counter). Framing metadata `sessionId:sequenceNum` authenticated as AAD in AES-256-GCM. Replayed or out-of-order sequence numbers are rejected. |
| **Trust Revocation** | **REAL** | Worker or host revocation permanently deletes records from `trusted_workers` SQLite table and terminates active sessions, enforcing re-pairing. |
| **IPC Hardening** | **REAL** | `/tmp/swarmx.sock` created with strict owner-only permissions (`0600` / `0o600`). |
| **Worker Manager** | **REAL** | Validates `capability_schema_version = 1`. Evaluates hard binary eligibility gate (`battery >= 20% || charging`, `thermal < SERIOUS`, `cpu < 90%`). |
| **macOS Worker** | **REAL** | Native Swift binary collecting real hardware metrics (`IOKit`, `ProcessInfo`), completing X25519 + SAS handshake, and streaming encrypted telemetry. |
| **Result Validator** | **REAL (FOUNDATION)** | Extension points in `core/src/result_validator.ts` with `PassThroughValidator`, `ExactMatchValidator` (SHA256 / string), and `ToleranceAwareNumericValidator` (floating-point epsilon checking across heterogeneous worker architectures). |
| **Scheduler** | **REAL (DETERMINISTIC FIFO)** | `IScheduler` interface with deterministic FIFO placement matching task resource constraints (CPU cores, RAM, GPU, battery). Adaptive/ML scheduling is deferred to Phase 1. |
| **VS Code Extension** | **REAL** | Communicates over local Unix socket IPC to display live worker states, telemetry, discovered devices, and trigger connect/revoke actions. |
| **Workload Pipeline** | *STUB* | Marked interface (`core/src/stubs/workload_pipeline.ts`). Static analysis, decomposition into DAGs, and result aggregation will be implemented in Phase 1 & 2. |
| **Sandboxed Execution** | *STUB* | macOS worker `ExecutionStub.swift` accepts task and returns canned success result. Native OS sandbox enforcement (`sandbox-exec` / Job Objects) will be implemented in Phase 1. |
| **Mobile Workers** | *OUT OF SCOPE* | Mobile workers (iOS / Android) deferred to later phase. |

---

## Transport & Framing Invariants

1. **Ordered Framing Invariant**:
   In Phase 0, encrypted session messages are required to arrive in strictly monotonically increasing sequence order (`incoming.sequenceNum > session.lastReceivedSequenceNum`). The underlying transport (WebSocket / gRPC streams over TCP) guarantees in-order delivery. Any replayed or out-of-order sequence number is rejected by design to guarantee replay protection.
2. **Session Key Isolation**:
   Session keys and 4-byte session IV salts are generated fresh per pairing session. No keys or IV nonces are shared across sessions.
3. **Glance-and-Tap Authorization**:
   Discovery (mDNS) is deliberately unauthenticated. Trust is established exclusively via human-confirmed SAS codes derived from the ECDH handshake transcript.

---

## Running & Testing Phase 0

### 1. Run Core Unit Test Suite
```bash
cd core
npm test
```
*Runs 22 unit tests covering TaskStore state machine, DAG cycle rejection, diamond graphs, crash & worker-loss recovery, lease expiration & heartbeat renewal, eligibility gates, 0600 socket mode, transcript-bound SAS comparison derivation, AES-GCM encryption, AAD tamper rejection, sequence replay protection, persisted revocation, result validation, and scheduler constraint matching.*

### 2. Run macOS Worker Swift Tests
```bash
cd worker-macos
swift test
```
*Runs 4 XCTest tests asserting capability schema versioning, native sensor reading, transcript-bound SAS derivation parity, and AES-GCM AAD encryption/decryption.*

### 3. Start SwarmX Core Daemon
```bash
cd core
npm start
```

### 4. Start macOS Worker
```bash
cd worker-macos
swift run swarmx-worker --connect
```
