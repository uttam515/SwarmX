import unittest
import os
from swarmx.client import SwarmClient

class TestIpcWorkload(unittest.TestCase):
    def test_evaluate_and_execute_fallback_when_core_offline(self):
        client = SwarmClient(socket_path="/tmp/nonexistent-swarmx-test-socket.sock")
        
        sample_workload = {
            "workloadId": "wkl-py-test-01",
            "version": "1.0.0",
            "computation": {
                "domain": "IMAGE_PROCESSING",
                "kernelId": "image_filter_box_blur_v1",
                "parameters": {"radius": 2}
            },
            "data": {
                "itemCount": 1,
                "totalPayloadBytes": 1048576,
                "format": "RAW_PLANAR_RGBA_UINT8"
            },
            "constraints": {
                "isPure": True,
                "isIdempotent": True,
                "toleranceValidator": "IMAGE_PIXEL_DELTA"
            }
        }

        # Client must handle offline Core gracefully without crashing
        self.assertFalse(client.connect())
        with self.assertRaises(ConnectionError):
            client.evaluate_workload(sample_workload)

        with self.assertRaises(ConnectionError):
            client.execute_workload(sample_workload)

if __name__ == "__main__":
    unittest.main()
