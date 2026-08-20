import unittest
import os
from unittest.mock import MagicMock, patch
from PIL import Image, ImageFilter
from swarmx.client import SwarmClient
from swarmx.interceptor.pil_filter import swarmx_image_filter, install_interceptor, uninstall_interceptor

class TestForceSwarmExecution(unittest.TestCase):
    def setUp(self):
        install_interceptor()

    def tearDown(self):
        uninstall_interceptor()
        if "SWARMX_FORCE_SWARM" in os.environ:
            del os.environ["SWARMX_FORCE_SWARM"]

    @patch("swarmx.interceptor.pil_filter.get_swarm_client")
    def test_force_swarm_dispatches_when_enabled(self, mock_get_client):
        mock_client = MagicMock()
        mock_client.is_connected.return_value = True
        mock_client.evaluate_workload.return_value = {"decision": "LOCAL", "reason": "Transfer overhead"}
        
        # Mock successful binary execution
        raw_output = b"\x8c" * (128 * 128 * 4) # 140 uint8
        mock_client.execute_workload_binary.return_value = ({"status": "COMPLETED"}, raw_output)
        mock_get_client.return_value = mock_client

        os.environ["SWARMX_FORCE_SWARM"] = "1"
        img = Image.new("RGBA", (128, 128), (140, 140, 140, 140))
        result = img.filter(ImageFilter.BoxBlur(2))

        self.assertIsInstance(result, Image.Image)
        # Verify execute_workload_binary was called with force_swarm=True
        mock_client.execute_workload_binary.assert_called_once()
        args, kwargs = mock_client.execute_workload_binary.call_args
        self.assertTrue(kwargs.get("force_swarm", False) or (len(args) >= 3 and args[2] is True))

    @patch("swarmx.interceptor.pil_filter.get_swarm_client")
    def test_force_swarm_raises_error_if_remote_execution_fails(self, mock_get_client):
        mock_client = MagicMock()
        mock_client.is_connected.return_value = True
        mock_client.evaluate_workload.return_value = {"decision": "LOCAL", "reason": "Transfer overhead"}
        
        # Mock failed binary execution
        mock_client.execute_workload_binary.return_value = (
            {"status": "FAILED", "reason": "No eligible remote worker available"},
            b""
        )
        mock_get_client.return_value = mock_client

        os.environ["SWARMX_FORCE_SWARM"] = "1"
        img = Image.new("RGBA", (128, 128), (140, 140, 140, 140))
        
        with self.assertRaises(RuntimeError) as ctx:
            img.filter(ImageFilter.BoxBlur(2))
        
        self.assertIn("Forced Swarm execution failed", str(ctx.exception))

    @patch("swarmx.interceptor.pil_filter.get_swarm_client")
    def test_normal_mode_respects_local_decision(self, mock_get_client):
        mock_client = MagicMock()
        mock_client.is_connected.return_value = True
        mock_client.evaluate_workload.return_value = {"decision": "LOCAL", "reason": "Transfer overhead"}
        mock_get_client.return_value = mock_client

        # No SWARMX_FORCE_SWARM
        img = Image.new("RGBA", (128, 128), (140, 140, 140, 140))
        result = img.filter(ImageFilter.BoxBlur(2))

        self.assertIsInstance(result, Image.Image)
        mock_client.evaluate_workload.assert_called_once()
        # In normal mode with LOCAL decision, binary execution is skipped
        mock_client.execute_workload_binary.assert_not_called()

    @patch("swarmx.interceptor.pil_filter.get_swarm_client")
    def test_cost_model_recommendation_unaltered_by_force_mode(self, mock_get_client):
        mock_client = MagicMock()
        mock_client.is_connected.return_value = True
        mock_client.evaluate_workload.return_value = {"decision": "LOCAL", "reason": "Transfer overhead"}
        mock_get_client.return_value = mock_client

        os.environ["SWARMX_FORCE_SWARM"] = "1"
        eval_res = mock_client.evaluate_workload({"computation": {"kernelId": "image_filter_box_blur_v1"}})
        self.assertEqual(eval_res["decision"], "LOCAL")
        self.assertEqual(eval_res["reason"], "Transfer overhead")

if __name__ == "__main__":
    unittest.main()
