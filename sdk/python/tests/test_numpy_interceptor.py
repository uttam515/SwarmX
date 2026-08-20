import unittest
import os
import sys
import numpy as np
from swarmx.interceptor.numpy_matmul import (
    is_certified_matmul,
    swarmx_matmul,
    install_interceptor as install_numpy_interceptor,
    uninstall_interceptor as uninstall_numpy_interceptor
)
from swarmx.interceptor.pil_filter import (
    install_interceptor as install_pil_interceptor,
    uninstall_interceptor as uninstall_pil_interceptor,
    is_certified_box_blur
)
from PIL import Image, ImageFilter

class TestNumPyInterceptor(unittest.TestCase):
    def setUp(self):
        install_numpy_interceptor()
        install_pil_interceptor()

    def tearDown(self):
        uninstall_numpy_interceptor()
        uninstall_pil_interceptor()

    def test_A_zero_import_transparent_matmul(self):
        """A. Validates that standard np.matmul works transparently with interceptor installed."""
        a = np.ones((64, 64), dtype=np.float32)
        b = np.ones((64, 64), dtype=np.float32)
        res = np.matmul(a, b)
        self.assertEqual(res.shape, (64, 64))
        self.assertEqual(res.dtype, np.float32)
        self.assertAlmostEqual(float(res[0, 0]), 64.0)

    def test_B_supported_float32_contract(self):
        """B. Validates is_certified_matmul accepts valid float32 2D C-contiguous arrays."""
        a = np.random.randn(256, 128).astype(np.float32)
        b = np.random.randn(128, 512).astype(np.float32)
        is_valid, msg = is_certified_matmul(a, b)
        self.assertTrue(is_valid, msg)

    def test_C_small_matrix_contract(self):
        """C. Validates that small matrices execute correctly with correct shape and values."""
        a = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)
        b = np.array([[5.0, 6.0], [7.0, 8.0]], dtype=np.float32)
        expected = np.dot(a, b)
        actual = np.matmul(a, b)
        np.testing.assert_allclose(actual, expected, rtol=1e-5, atol=1e-5)

    def test_D_core_offline_fallback(self):
        """D. Core offline / socket missing safely falls back to native NumPy."""
        os.environ["SWARMX_SOCKET_PATH"] = "/tmp/nonexistent_socket_test.sock"
        a = np.random.randn(128, 128).astype(np.float32)
        b = np.random.randn(128, 128).astype(np.float32)
        res = np.matmul(a, b)
        expected = np.dot(a, b)
        np.testing.assert_allclose(res, expected, rtol=1e-5, atol=1e-5)

    def test_E_incompatible_shapes(self):
        """E. Incompatible inner dimensions fail certification."""
        a = np.ones((64, 32), dtype=np.float32)
        b = np.ones((64, 128), dtype=np.float32)
        is_valid, reason = is_certified_matmul(a, b)
        self.assertFalse(is_valid)
        self.assertIn("Incompatible", reason)

    def test_F_float64_fallback(self):
        """F. float64 arrays are rejected by certification and fallback to native NumPy."""
        a = np.ones((64, 64), dtype=np.float64)
        b = np.ones((64, 64), dtype=np.float64)
        is_valid, reason = is_certified_matmul(a, b)
        self.assertFalse(is_valid)
        self.assertIn("float32", reason)

    def test_G_non_contiguous_fallback(self):
        """G. Non-contiguous (e.g. transposed/sliced) arrays fail eligibility check without copies."""
        base = np.ones((128, 128), dtype=np.float32)
        a_sliced = base[::2, ::2]  # Non-contiguous stride
        b = np.ones((64, 64), dtype=np.float32)
        is_valid, reason = is_certified_matmul(a_sliced, b)
        self.assertFalse(is_valid)
        self.assertIn("contiguous", reason)

    def test_H_numerical_correctness(self):
        """H. Verified float32 matrix multiply precision."""
        np.random.seed(42)
        a = np.random.uniform(-10.0, 10.0, (128, 128)).astype(np.float32)
        b = np.random.uniform(-10.0, 10.0, (128, 128)).astype(np.float32)
        expected = np.dot(a, b)
        actual = np.matmul(a, b)
        max_err = float(np.max(np.abs(actual - expected)))
        self.assertLess(max_err, 1e-4)

    def test_I_pilot_boxblur_regression(self):
        """I. Validates that existing PIL BoxBlur interception continues to work seamlessly."""
        img = Image.new("RGBA", (128, 128), color=(100, 150, 200, 255))
        is_box_valid = is_certified_box_blur(ImageFilter.BoxBlur(2))
        self.assertTrue(is_box_valid)
        filtered = img.filter(ImageFilter.BoxBlur(2))
        self.assertEqual(filtered.size, (128, 128))

if __name__ == "__main__":
    unittest.main()
