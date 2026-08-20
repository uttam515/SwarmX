import json
import socket
import os
from typing import Dict, Any, Optional

class SwarmClient:
    """
    SwarmX Core IPC Client for communicating over the local Unix domain socket (/tmp/swarmx.sock).
    """
    def __init__(self, socket_path: str = "/tmp/swarmx.sock", timeout: float = 5.0):
        self.socket_path = socket_path
        self.timeout = timeout
        self.sock: Optional[socket.socket] = None
        self._req_id = 1

    def connect(self) -> bool:
        if not os.path.exists(self.socket_path):
            return False
        try:
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(self.timeout)
            self.sock.connect(self.socket_path)
            return True
        except Exception:
            self.sock = None
            return False

    def is_connected(self) -> bool:
        return self.sock is not None

    def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self.is_connected():
            if not self.connect():
                raise ConnectionError(f"Cannot connect to SwarmX Core socket at {self.socket_path}")

        req_id = self._req_id
        self._req_id += 1
        msg = {
            "id": req_id,
            "method": method,
            "params": params or {}
        }

        payload = json.dumps(msg) + "\n"
        self.sock.sendall(payload.encode("utf-8"))

        buffer = ""
        while True:
            chunk = self.sock.recv(4096).decode("utf-8")
            if not chunk:
                raise ConnectionResetError("SwarmX Core closed the connection")
            buffer += chunk
            if "\n" in buffer:
                line, _ = buffer.split("\n", 1)
                res = json.loads(line)
                if "error" in res and res["error"]:
                    raise RuntimeError(f"SwarmX Core error: {res['error']}")
                return res.get("result", {})

    def get_status(self) -> Dict[str, Any]:
        return self.request("getStatus")

    def list_connected_workers(self) -> list:
        return self.request("listConnectedWorkers")

    def submit_task(self, task_def: Dict[str, Any]) -> Dict[str, Any]:
        return self.request("submitTask", {"task": task_def})

    def evaluate_workload(self, workload: Dict[str, Any]) -> Dict[str, Any]:
        return self.request("evaluateWorkload", {"workload": workload})

    def execute_workload(self, workload: Dict[str, Any]) -> Dict[str, Any]:
        return self.request("executeWorkload", {"workload": workload})

    def execute_workload_binary(self, workload_metadata: Dict[str, Any], raw_payload_bytes: bytes) -> tuple:
        """
        Milestone 2.1 Zero-Copy Binary Workload Execution:
        Transfers raw binary planar bytes without Base64 encoding.
        Returns (result_metadata_dict, raw_output_bytes).
        """
        import struct

        if not self.is_connected():
            if not self.connect():
                raise ConnectionError(f"Cannot connect to SwarmX Core socket at {self.socket_path}")

        req_id = self._req_id
        self._req_id += 1
        
        # Ensure totalPayloadBytes reflects raw bytes length
        if "data" not in workload_metadata:
            workload_metadata["data"] = {}
        workload_metadata["data"]["totalPayloadBytes"] = len(raw_payload_bytes)

        msg = {
            "id": req_id,
            "method": "executeWorkload",
            "params": {"workload": workload_metadata}
        }

        json_bytes = json.dumps(msg).encode("utf-8")
        header = b"SWRM" + struct.pack(">I", len(json_bytes))
        
        # Send header + json metadata + raw payload
        self.sock.sendall(header + json_bytes + raw_payload_bytes)

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
        expected_output_bytes = res.get("totalPayloadBytes", len(raw_payload_bytes))
        if res.get("status") != "COMPLETED":
            expected_output_bytes = 0

        # Read raw output payload
        output_bytes = bytearray()
        while len(output_bytes) < expected_output_bytes:
            chunk = self.sock.recv(min(65536, expected_output_bytes - len(output_bytes)))
            if not chunk:
                break
            output_bytes.extend(chunk)

        return res, bytes(output_bytes)

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None

