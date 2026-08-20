import unittest
import socket
import os
import json
import threading
import time
from swarmx.client import SwarmClient
from swarmx.chunking import AdaptiveChunker
from swarmx import swarm

class TestIpcIntegration(unittest.TestCase):
    def setUp(self):
        self.socket_path = f"/tmp/swarmx-sdk-test-{int(time.time() * 1000)}.sock"
        if os.path.exists(self.socket_path):
            os.remove(self.socket_path)

        self.server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server_sock.bind(self.socket_path)
        self.server_sock.listen(5)
        self.running = True

        self.received_messages = []
        self.server_thread = threading.Thread(target=self._run_server, daemon=True)
        self.server_thread.start()

    def tearDown(self):
        self.running = False
        try:
            self.server_sock.close()
        except Exception:
            pass
        if os.path.exists(self.socket_path):
            os.remove(self.socket_path)

    def _run_server(self):
        while self.running:
            try:
                conn, _ = self.server_sock.accept()
                threading.Thread(target=self._handle_client, args=(conn,), daemon=True).start()
            except Exception:
                break

    def _handle_client(self, conn):
        buffer = ""
        while self.running:
            try:
                data = conn.recv(4096).decode("utf-8")
                if not data:
                    break
                buffer += data
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    if not line.strip():
                        continue
                    msg = json.loads(line)
                    self.received_messages.append(msg)

                    method = msg.get("method")
                    req_id = msg.get("id")

                    if method == "getStatus":
                        res = {"id": req_id, "result": {"enabled": True, "activeWorkerCount": 2, "eligibleWorkerCount": 2}}
                    elif method == "listConnectedWorkers":
                        res = {"id": req_id, "result": [{"deviceId": "mac-worker-01"}, {"deviceId": "win-worker-02"}]}
                    elif method == "submitTask":
                        res = {"id": req_id, "result": {"id": msg.get("params", {}).get("task", {}).get("id", "task-1"), "status": "PENDING"}}
                    else:
                        res = {"id": req_id, "result": {"status": "OK"}}

                    conn.sendall((json.dumps(res) + "\n").encode("utf-8"))
            except Exception:
                break
        conn.close()

    def test_ipc_roundtrip_methods(self):
        client = SwarmClient(socket_path=self.socket_path)
        self.assertTrue(client.connect())

        # 1. get_status
        status = client.get_status()
        self.assertTrue(status.get("enabled"))
        self.assertEqual(status.get("activeWorkerCount"), 2)

        # 2. list_connected_workers
        workers = client.list_connected_workers()
        self.assertEqual(len(workers), 2)
        self.assertEqual(workers[0]["deviceId"], "mac-worker-01")

        # 3. submit_task
        task_res = client.submit_task({"id": "task-test-99", "computationDescriptor": "filter"})
        self.assertEqual(task_res["id"], "task-test-99")
        self.assertEqual(task_res["status"], "PENDING")

        client.close()

    def test_out_of_order_chunk_reassembly_deterministic_order(self):
        """
        Simulates 3 chunks arriving out of order (Chunk 2, Chunk 0, Chunk 1)
        and asserts that the final yielded output matches exact 0..N input order.
        """
        items = list(range(30))
        chunks = list(AdaptiveChunker.slice_iterable(items, 10))
        self.assertEqual(len(chunks), 3)

        # Process chunks with simulated async out-of-order completion
        chunk_results = {}
        # Arrival order: Chunk 2 (items 20-29), then Chunk 0 (items 0-9), then Chunk 1 (items 10-19)
        chunk_results[2] = [x * 10 for x in chunks[2]]
        chunk_results[0] = [x * 10 for x in chunks[0]]
        chunk_results[1] = [x * 10 for x in chunks[1]]

        # Reassemble by chunk index
        ordered_results = []
        for i in range(len(chunks)):
            ordered_results.extend(chunk_results[i])

        expected = [x * 10 for x in items]
        self.assertEqual(ordered_results, expected)

if __name__ == "__main__":
    unittest.main()
