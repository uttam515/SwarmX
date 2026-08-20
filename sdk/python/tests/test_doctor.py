import unittest
from swarmx.doctor import run_diagnostics

class TestSwarmXDoctor(unittest.TestCase):
    def test_run_diagnostics_structure(self):
        """Doctor reports all 6 diagnostic layers with structured fields."""
        report = run_diagnostics(ipc_socket_path="/tmp/nonexistent.sock", target_host="127.0.0.1", target_port=59999)
        
        self.assertIn("timestamp", report)
        self.assertIn("network", report)
        self.assertIn("bonjour", report)
        self.assertIn("transport", report)
        self.assertIn("protocol", report)
        self.assertIn("pairing", report)
        self.assertIn("execution", report)
        
        self.assertEqual(report["bonjour"]["serviceType"], "_swarmx._tcp")
        self.assertEqual(report["execution"]["certifiedKernel"], "image_filter_box_blur_v1")
        self.assertIn("webSocketConnections", report["protocol"])
        self.assertIn("discoveredWorkers", report["protocol"])
        self.assertIn("registeredWorkers", report["protocol"])
        self.assertIn("pairedWorkers", report["protocol"])
        self.assertIn("eligibleWorkers", report["protocol"])

if __name__ == "__main__":
    unittest.main()
