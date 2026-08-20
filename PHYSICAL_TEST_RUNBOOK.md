# 🐝 SwarmX Physical Mac-to-Mac Two-Node Validation Runbook

This runbook defines the exact step-by-step procedure for validating SwarmX on two physical MacBooks over a local Wi-Fi / Hotspot network.

---

## 📋 Pre-Flight Checklist

1. Both MacBooks (Mac #1 and Mac #2) connected to the **same Wi-Fi network** or personal hotspot.
2. Mac #1: Host Development Machine (runs Core daemon + Python application).
3. Mac #2: Remote Compute Node (runs native Swift worker).

---

## 🚀 Execution Steps

### Step 1: Start SwarmX Core on Mac #1 (Host)
```bash
./bin/swarmx start
# or: cd core && npm start
```
*Expected Output*:
- Core binds Unix socket at `/tmp/swarmx.sock` (mode 0600)
- Transport WebSocket server starts on port `50051`
- Bonjour mDNS service advertises `_swarmx._tcp.local` on local network

---

### Step 2: Start Native Worker on Mac #2 (Remote Worker)
*Zero-configuration automatic discovery:*
```bash
cd worker-macos && swift run swarmx-worker
```
*Expected Output*:
- Automatic NWBrowser mDNS discovery locates Mac #1's `_swarmx._tcp` broadcast.
- Connects WebSocket to `ws://<Mac1-IP>:50051`.
- Sends `DISCOVERY_BEACON` with Apple Silicon capability profile.
- Displays 4-Digit SAS confirmation prompt on terminal.

---

### Step 3: Glance-and-Tap SAS Confirmation
1. In VS Code on Mac #1 (or via IPC prompt), verify the 4-digit code matches the code on Mac #2.
2. Confirm pairing $\implies$ Host & Worker derive independent directional AES-256-GCM session keys ($K_{h \to w}, K_{w \to h}$).
3. Node transitions to `🟢 Eligible` in the VS Code SwarmX Dashboard.

---

### Step 4: Execute Flagship Demo (Unmodified Python Application)
On Mac #1:
```bash
./bin/swarmx demo
# or: PYTHONPATH=sdk/python SWARMX_DEBUG=1 python3 examples/flagship_demo.py
```
*Expected Behavior*:
1. Application contains **zero** SwarmX imports.
2. `sitecustomize` transparently intercepts `img.filter(ImageFilter.BoxBlur(2))`.
3. Workload IR is generated and evaluated via Core Decision Engine.
4. Core splits workload chunks and dispatches encrypted payload over Wi-Fi to Mac #2.
5. Mac #2 executes native 2D BoxBlur Metal/Accelerate kernel.
6. Core validates returned pixels ($\Delta \le 2, \text{MSE} \le 0.5$) and returns real `PIL.Image.Image`.
7. Output displays total completion time and measured two-node speedup.

---

## 🩺 Diagnostic Troubleshooting Tree

If any step fails, run `./bin/swarmx doctor` on Mac #1 to identify the exact failing layer:

```
+-------------------------------------------------------------------------+
| Fail Layer    | Symptom                         | Action                |
+-------------------------------------------------------------------------+
| [1] Network   | Local IP is 127.0.0.1           | Check Wi-Fi connection|
| [2] Bonjour   | Mac #2 cannot find host         | Check AP Isolation /  |
|               |                                 | Use Samsung Hotspot   |
| [3] Transport | TCP Connection refused (50051)  | Check macOS Firewall  |
| [4] Protocol  | Beacon sent but no ACK          | Check Core logs       |
| [5] Pairing   | SAS Mismatch / Rejected         | Re-pair devices       |
| [6] Execution | Tolerance Validation Failure    | Inspect kernel delta  |
+-------------------------------------------------------------------------+
```

---

*All network framing, Bonjour mDNS discovery, NWConnection, WebSocket transport, and directional cryptographic suites are frozen in their passing state.*
