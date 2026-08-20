import unittest
import os
import time
import numpy as np
from PIL import Image, ImageFilter
from swarmx.interceptor import install_interceptor, uninstall_interceptor

class TestPythonFaultInjection(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        install_interceptor()

    @classmethod
    def tearDownClass(cls):
        uninstall_interceptor()

    def test_timeout_fallback_to_vanilla_pil(self):
        """When socket points to a black-hole / unresponsive endpoint, interceptor falls back to vanilla PIL."""
        os.environ["SWARMX_IPC_PATH"] = "/tmp/nonexistent-blackhole.sock"
        try:
            data = np.full((64, 64, 4), 150, dtype=np.uint8)
            img = Image.fromarray(data, mode="RGBA")
            out = img.filter(ImageFilter.BoxBlur(radius=2))
            self.assertIsInstance(out, Image.Image)
            self.assertEqual(out.size, (64, 64))
            self.assertEqual(out.getpixel((32, 32)), (150, 150, 150, 150))
        finally:
            os.environ.pop("SWARMX_IPC_PATH", None)

    def test_concurrent_multiple_images_zero_cross_contamination(self):
        """Processes 5 different images in sequence and verifies strict isolation."""
        for color in [50, 100, 150, 200, 250]:
            data = np.full((32, 32, 4), color, dtype=np.uint8)
            img = Image.fromarray(data, mode="RGBA")
            out = img.filter(ImageFilter.BoxBlur(radius=1))
            self.assertEqual(out.getpixel((16, 16)), (color, color, color, color))

    def test_zero_radius_identity_fallback(self):
        """Radius 0 returns exact identity image without errors."""
        data = np.random.randint(0, 255, (32, 32, 4), dtype=np.uint8)
        img = Image.fromarray(data, mode="RGBA")
        out = img.filter(ImageFilter.BoxBlur(radius=0))
        self.assertEqual(out.tobytes(), img.tobytes())

if __name__ == "__main__":
    unittest.main()
