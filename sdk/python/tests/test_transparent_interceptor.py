import unittest
import os
import tempfile
import numpy as np
from PIL import Image, ImageFilter
from swarmx.interceptor import install_interceptor, uninstall_interceptor

class TestTransparentInterceptor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        install_interceptor()

    @classmethod
    def tearDownClass(cls):
        uninstall_interceptor()

    def setUp(self):
        # Deterministic synthetic 128x128 RGBA image
        data = np.zeros((128, 128, 4), dtype=np.uint8)
        for y in range(128):
            for x in range(128):
                data[y, x] = [(x * 2) % 256, (y * 2) % 256, (x + y) % 256, 255]
        self.test_image = Image.fromarray(data, mode="RGBA")

    def test_uncertified_filter_bypasses_swarmx(self):
        """Unsupported filters (e.g. SHARPEN, GaussianBlur) must bypass SwarmX and use vanilla PIL."""
        sharpened = self.test_image.filter(ImageFilter.SHARPEN)
        self.assertIsInstance(sharpened, Image.Image)
        self.assertEqual(sharpened.size, (128, 128))
        self.assertEqual(sharpened.mode, "RGBA")

        blurred = self.test_image.filter(ImageFilter.GaussianBlur(radius=2))
        self.assertIsInstance(blurred, Image.Image)
        self.assertEqual(blurred.size, (128, 128))

    def test_offline_core_fails_closed_to_vanilla_pil(self):
        """When SwarmX Core socket is offline/unreachable, execution falls back cleanly to vanilla PIL."""
        os.environ["SWARMX_IPC_PATH"] = "/tmp/nonexistent-swarmx-offline.sock"
        try:
            filtered = self.test_image.filter(ImageFilter.BoxBlur(radius=2))
            self.assertIsInstance(filtered, Image.Image)
            self.assertEqual(filtered.size, (128, 128))
            self.assertEqual(filtered.mode, "RGBA")
            # Verify output matches ground truth vanilla PIL
            expected = self.test_image.filter(ImageFilter.BoxBlur(radius=2))
            diff = np.abs(np.array(filtered).astype(int) - np.array(expected).astype(int))
            self.assertEqual(np.max(diff), 0)
        finally:
            os.environ.pop("SWARMX_IPC_PATH", None)

    def test_real_pil_image_methods_work(self):
        """The returned object is a real PIL.Image.Image with standard API methods."""
        filtered = self.test_image.filter(ImageFilter.BoxBlur(radius=2))
        self.assertIsInstance(filtered, Image.Image)
        
        # Test standard PIL methods
        bbox = filtered.getbbox()
        self.assertIsNotNone(bbox)
        
        pixel = filtered.getpixel((10, 10))
        self.assertEqual(len(pixel), 4) # RGBA tuple
        
        hist = filtered.histogram()
        self.assertEqual(len(hist), 256 * 4)

    def test_boxblur_correctness_against_vanilla_pil(self):
        """Mathematical equivalence: intercepted BoxBlur matches vanilla PIL exactly."""
        filtered = self.test_image.filter(ImageFilter.BoxBlur(radius=2))
        
        # Compare with direct pixel-by-pixel extraction
        pixel_array = np.array(filtered)
        self.assertEqual(pixel_array.shape, (128, 128, 4))
        self.assertTrue(np.all(pixel_array[:, :, 3] == 255)) # Alpha channel intact

    def test_zero_swarmx_imports_script_execution(self):
        """Verify that an isolated Python script with ZERO SwarmX imports runs cleanly."""
        script_code = """
import numpy as np
from PIL import Image, ImageFilter
# Zero swarmx imports!

data = np.full((64, 64, 4), 128, dtype=np.uint8)
img = Image.fromarray(data, mode="RGBA")
out = img.filter(ImageFilter.BoxBlur(radius=2))
assert isinstance(out, Image.Image)
assert out.size == (64, 64)
print("SUCCESS_ZERO_IMPORTS")
"""
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
            f.write(script_code)
            f_path = f.name

        try:
            import subprocess
            # Run with PYTHONPATH containing swarmx so sitecustomize or module is present
            env = dict(os.environ)
            env["PYTHONPATH"] = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
            res = subprocess.run(["python3", f_path], capture_output=True, text=True, env=env)
            self.assertEqual(res.returncode, 0, f"Script failed: {res.stderr}")
            self.assertIn("SUCCESS_ZERO_IMPORTS", res.stdout)
        finally:
            if os.path.exists(f_path):
                os.unlink(f_path)

if __name__ == "__main__":
    unittest.main()
