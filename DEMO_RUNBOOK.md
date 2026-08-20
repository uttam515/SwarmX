# 🐝 SwarmX Demonstration Runbook

This runbook provides the exact command sequences for demonstrating SwarmX in both standalone (single-machine prototype) and distributed (two-Mac cluster) modes.

---

## 🎬 1. Standalone Demo (No Mac #2 Required)

This mode demonstrates the zero-import transparent PIL acceleration, cost-benefit decision engine, and fallback safety on a single MacBook.

### Step 1: Start SwarmX Core Daemon
In Terminal #1:
```bash
./bin/swarmx start
```
*Expected Output:*
- Core binds IPC socket at `/tmp/swarmx.sock` (mode 0600)
- WebSocket transport server listens on port `50051`
- Bonjour mDNS service advertises `_swarmx._tcp.local`
- Logs stream to `/tmp/swarmx-core.log`

---

### Step 2: Verify Host Diagnostics
In Terminal #2:
```bash
./bin/swarmx doctor
```
*Expected Output:*
- Layers 1–6 report `ONLINE` / `READY`
- `Registered Workers: 0`
- Diagnostic Verdict: `READY FOR PHYSICAL TEST`

---

### Step 3: Run the Flagship Demo
In Terminal #2:
```bash
./bin/swarmx demo
```
*Expected Output:*
- Application runs as 100% standard, unmodified PIL Python script (`Image.filter(ImageFilter.BoxBlur(2))`)
- Cluster shows `Core: ● ONLINE`, `Local Host: ● READY`, `Remote: 0`
- Decision Engine transparently evaluates cost model (`LOCAL FALLBACK: No eligible remote worker`)
- Progress bar renders live to 100%
- Output verifies 1,000 authentic `PIL.Image.Image` results and pixel integrity ($Δ \le 2, \text{MSE} \le 0.5$)
- Displays runtime metrics and throughput in MB/s

---

## 🌐 2. Distributed Two-Mac Demo (With Mac #2 Connected)

This mode demonstrates distributed compute offloading, autonomous Bonjour discovery, and SAS cryptographic pairing.

### Step 1: Start Core on Mac #1 (Host)
On Mac #1:
```bash
./bin/swarmx start
```

---

### Step 2: Start Native Swift Worker on Mac #2 (Compute Node)
On Mac #2:
```bash
cd worker-macos && swift run swarmx-worker
```
*Expected Output:*
- Mac #2 auto-discovers Mac #1 via Bonjour `_swarmx._tcp.local`
- Establishes WebSocket to `ws://<Mac1-IP>:50051`
- Sends `DISCOVERY_BEACON` with Apple Silicon capability profile

---

### Step 3: Pair Devices
1. On Mac #1 in VS Code:
   - Open the **SwarmX** activity bar
   - Under **Discovered Nearby Devices**, click the plug icon (`Connect / Pair Worker`) next to Mac #2
2. On Mac #2 terminal:
   - Compare the 4-digit SAS comparison code displayed on both screens
   - Press `y` to confirm trust

---

### Step 4: Run the Flagship Demo on Mac #1
On Mac #1:
```bash
./bin/swarmx demo
```
*Expected Output:*
- Cluster displays `Host: ● READY`, `<Mac2-Name> [⚡ GPU]: ● READY`
- Decision Engine selects `Mode: SWARM`
- Workload chunks are distributed over local network to Mac #2
- Progress bar ticks to 100% and displays measured distributed throughput

---

## 🔍 3. Viewing Host Observability Logs
On Mac #1:
```bash
cat /tmp/swarmx-core.log
# or follow live:
tail -f /tmp/swarmx-core.log
```
*Expected Log Entries:*
```
[TRANSPORT]    WebSocket accepted from 192.168.1.102
[HANDSHAKE]    Worker identity received: macos-worker-XXXX (MacBook Pro)
[CAPABILITIES] Capabilities received for macos-worker-XXXX: OS=darwin, Arch=arm64, Cores=12, RAM=32768MB, GPU=Yes
[PAIRING]      Pairing initiated / SAS verified successfully
[REGISTRATION] Worker registered: macos-worker-XXXX
[WORKER STATE] DISCOVERED -> PAIRING -> CONNECTED -> READY
```
