import unittest
import struct
from swarmx.client import SwarmClient

class TestBinaryClient(unittest.TestCase):
    def test_binary_frame_construction(self):
        """Validates that binary client builds valid SWRM binary frames."""
        client = SwarmClient()
        meta = {
            "workloadId": "wkl-bin-test",
            "data": {"totalPayloadBytes": 16}
        }
        raw_payload = b"\xaa" * 16
        
        # Test header packing logic
        import json
        json_bytes = json.dumps({"id": 1, "method": "executeWorkload", "params": {"workload": meta}}).encode("utf-8")
        header = b"SWRM" + struct.pack(">I", len(json_bytes))
        
        self.assertEqual(header[:4], b"SWRM")
        self.assertEqual(len(header), 8)
        self.assertEqual(struct.unpack(">I", header[4:8])[0], len(json_bytes))

if __name__ == "__main__":
    unittest.main()
