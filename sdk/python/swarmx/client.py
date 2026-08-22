import json
import socket
import os
import time
import threading
from typing import Dict, Any, Optional, Tuple

_THREAD_LOCAL = threading.local()

def get_thread_local_client(socket_path: str = "/tmp/swarmx.sock", timeout: float = 30.0) -> 'SwarmClient':
    """
    Returns a thread-isolated SwarmClient instance using threading.local().
    Guarantees that concurrent threads in ThreadPoolExecutor/multithreading
    each have an independent persistent Unix domain socket connection, preventing
    interleaving of binary request/response frames.
    """
    client = getattr(_THREAD_LOCAL, "client", None)
    if client is None or not client.is_connected() or client.socket_path != socket_path:
        client = SwarmClient(socket_path=socket_path, timeout=timeout)
        client.connect()
        _THREAD_LOCAL.client = client
    return client

class SwarmClient:
    """
    SwarmX Core IPC Client for communicating over the local Unix domain socket (/tmp/swarmx.sock).
    Maintains persistent thread-isolated Unix socket connections with automatic reconnect on disruption.
    """
    def __init__(self, socket_path: str = "/tmp/swarmx.sock", timeout: float = 30.0):
        env_timeout = os.environ.get("SWARMX_WORKLOAD_TIMEOUT_MS")
        if env_timeout:
            timeout = float(env_timeout) / 1000.0
        self.socket_path = socket_path
        self.timeout = timeout
        self.sock: Optional[socket.socket] = None
        self._req_id = 1
        self._recv_buffer = ""

    def connect(self) -> bool:
        if self.sock is not None:
            self.close()
        if not os.path.exists(self.socket_path):
            return False
        try:
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(min(1.0, self.timeout))
            self.sock.connect(self.socket_path)
            self.sock.settimeout(self.timeout)
            self._recv_buffer = ""
            return True
        except Exception:
            if self.sock is not None:
                try:
                    self.sock.close()
                except Exception:
                    pass
            self.sock = None
            return False

    def is_connected(self) -> bool:
        return self.sock is not None

    def _ensure_connected(self) -> None:
        if not self.is_connected():
            if not self.connect():
                raise ConnectionError(f"Cannot connect to SwarmX Core socket at {self.socket_path}")

    def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Sends a JSON-RPC request over the persistent connection and reads the response line.
        Automatically reconnects once if a broken pipe / socket reset occurs.
        """
        for attempt in range(2):
            self._ensure_connected()
            req_id = self._req_id
            self._req_id += 1
            msg = {
                "id": req_id,
                "method": method,
                "params": params or {}
            }

            payload = json.dumps(msg) + "\n"
            try:
                self.sock.sendall(payload.encode("utf-8"))

                while "\n" not in self._recv_buffer:
                    chunk = self.sock.recv(4096).decode("utf-8")
                    if not chunk:
                        raise ConnectionResetError("SwarmX Core closed the connection")
                    self._recv_buffer += chunk

                line, self._recv_buffer = self._recv_buffer.split("\n", 1)
                res = json.loads(line)
                if "error" in res and res["error"]:
                    raise RuntimeError(f"SwarmX Core error: {res['error']}")
                return res.get("result", {})
            except (socket.error, BrokenPipeError, ConnectionResetError) as e:
                self.close()
                if attempt == 1:
                    raise ConnectionError(f"Persistent socket request failed after reconnect: {e}")

    def get_status(self) -> Dict[str, Any]:
        return self.request("getStatus")

    def list_connected_workers(self) -> list:
        return self.request("listConnectedWorkers")

    def submit_task(self, task_def: Dict[str, Any]) -> Dict[str, Any]:
        return self.request("submitTask", {"task": task_def})

    def evaluate_workload(self, workload: Dict[str, Any]) -> Dict[str, Any]:
        return self.request("evaluateWorkload", {"workload": workload})

    def execute_workload(self, workload: Dict[str, Any], force_swarm: bool = False) -> Dict[str, Any]:
        return self.request("executeWorkload", {"workload": workload, "forceSwarm": force_swarm})

    def execute_workload_binary(
        self,
        workload_metadata: Dict[str, Any],
        raw_payload_bytes: bytes,
        force_swarm: bool = False
    ) -> Tuple[Dict[str, Any], bytes]:
        """
        Zero-Copy Binary Workload Execution over the persistent thread socket.
        Transfers raw binary planar bytes without Base64 encoding.
        Returns (result_metadata_dict, raw_output_bytes).
        """
        import struct

        t_start = time.perf_counter()

        env_timeout = os.environ.get("SWARMX_WORKLOAD_TIMEOUT_MS")
        if env_timeout:
            effective_timeout = float(env_timeout) / 1000.0
        else:
            # Size-aware timeout: 30s base + 1.5s per MB of payload
            # (1024x1024 [8MB]: 42s; 2048x2048 [32MB]: 78s; 4096x4096 [128MB]: 222s)
            payload_mb = len(raw_payload_bytes) / (1024 * 1024)
            effective_timeout = max(30.0, min(300.0, 30.0 + payload_mb * 1.5))

        for attempt in range(2):
            self._ensure_connected()
            if self.sock:
                self.sock.settimeout(effective_timeout)
            req_id = self._req_id
            self._req_id += 1

            if "data" not in workload_metadata:
                workload_metadata["data"] = {}
            workload_metadata["data"]["totalPayloadBytes"] = len(raw_payload_bytes)

            msg = {
                "id": req_id,
                "method": "executeWorkload",
                "params": {"workload": workload_metadata, "forceSwarm": force_swarm},
                "totalPayloadBytes": len(raw_payload_bytes)
            }

            json_bytes = json.dumps(msg).encode("utf-8")
            header = b"SWRM" + struct.pack(">I", len(json_bytes))

            try:
                t_send_start = time.perf_counter()
                # Send header + json metadata + raw payload over persistent socket
                self.sock.sendall(header + json_bytes + raw_payload_bytes)
                t_send_end = time.perf_counter()
                python_send_ms = (t_send_end - t_send_start) * 1000.0

                t_recv_start = time.perf_counter()
                # Read binary response header (8 bytes)
                resp_header = b""
                while len(resp_header) < 8:
                    chunk = self.sock.recv(8 - len(resp_header))
                    if not chunk:
                        raise ConnectionResetError("Core socket closed during binary header read")
                    resp_header += chunk

                magic = resp_header[:4]
                if magic != b"SWRM":
                    raise ValueError(f"Invalid binary frame magic: {magic}")

                resp_json_len = struct.unpack(">I", resp_header[4:8])[0]

                # Read JSON response metadata
                resp_json_bytes = b""
                while len(resp_json_bytes) < resp_json_len:
                    chunk = self.sock.recv(min(4096, resp_json_len - len(resp_json_bytes)))
                    if not chunk:
                        raise ConnectionResetError("Core socket closed during metadata read")
                    resp_json_bytes += chunk

                resp_meta = json.loads(resp_json_bytes.decode("utf-8"))
                if "error" in resp_meta and resp_meta["error"]:
                    raise RuntimeError(f"SwarmX Core error: {resp_meta['error']}")

                res = resp_meta.get("result", {})
                expected_output_bytes = res.get("totalPayloadBytes", resp_meta.get("totalPayloadBytes", 0))
                if res.get("status") != "COMPLETED":
                    expected_output_bytes = 0

                # Read raw output payload directly into memory
                output_bytes = bytearray()
                while len(output_bytes) < expected_output_bytes:
                    chunk = self.sock.recv(min(65536, expected_output_bytes - len(output_bytes)))
                    if not chunk:
                        break
                    output_bytes.extend(chunk)

                t_recv_end = time.perf_counter()
                python_recv_ms = (t_recv_end - t_recv_start) * 1000.0

                if "telemetry" not in res:
                    res["telemetry"] = {}
                res["telemetry"]["pythonSendMs"] = python_send_ms
                res["telemetry"]["pythonReceiveMs"] = python_recv_ms
                res["telemetry"]["pythonWireMs"] = python_send_ms + python_recv_ms
                res["telemetry"]["pythonRoundTripMs"] = (t_recv_end - t_send_start) * 1000.0
                res["telemetry"]["pythonEvalRoundTripMs"] = 0.0

                return res, bytes(output_bytes)

            except (socket.error, BrokenPipeError, ConnectionResetError) as e:
                self.close()
                if attempt == 1:
                    raise ConnectionError(f"Binary frame execution failed after reconnect: {e}")

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None
        self._recv_buffer = ""
