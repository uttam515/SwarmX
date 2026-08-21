import unittest
import threading
import concurrent.futures
import numpy as np
import os
from PIL import Image, ImageFilter
from swarmx.client import SwarmClient, get_thread_local_client
from swarmx.interceptor.numpy_matmul import swarmx_matmul, install_interceptor as install_numpy_interceptor
from swarmx.interceptor.pil_filter import swarmx_image_filter, install_interceptor as install_pil_interceptor

class TestParallelDispatch(unittest.TestCase):
    def setUp(self):
        install_numpy_interceptor()
        install_pil_interceptor()

    def test_01_thread_local_client_isolation(self):
        """Verify each thread gets an isolated SwarmClient instance."""
        clients = {}
        barrier = threading.Barrier(2)

        def worker(thread_idx):
            client = get_thread_local_client(socket_path="/tmp/nonexistent-test.sock")
            clients[thread_idx] = client
            barrier.wait()

        t1 = threading.Thread(target=worker, args=(1,))
        t2 = threading.Thread(target=worker, args=(2,))
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        self.assertIn(1, clients)
        self.assertIn(2, clients)
        # Each thread must possess its own unique client object in memory
        self.assertIsNot(clients[1], clients[2])

    def test_02_concurrent_matmul_execution(self):
        """Verify concurrent multi-threaded np.matmul execution across ThreadPoolExecutor."""
        np.random.seed(42)
        pairs = [
            (np.random.randn(64, 64).astype(np.float32), np.random.randn(64, 64).astype(np.float32))
            for _ in range(8)
        ]

        def compute_pair(pair):
            A, B = pair
            C = np.matmul(A, B)
            expected = np.dot(A, B)
            max_err = float(np.max(np.abs(C - expected)))
            return isinstance(C, np.ndarray) and C.shape == (64, 64) and max_err < 1e-4

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(compute_pair, pairs))

        self.assertEqual(len(results), 8)
        self.assertTrue(all(results))

    def test_03_concurrent_box_blur_execution(self):
        """Verify concurrent PIL BoxBlur filtering across ThreadPoolExecutor."""
        images = [Image.new("RGBA", (128, 128), color=(i * 20, 100, 150, 255)) for i in range(4)]

        def filter_img(img):
            out = img.filter(ImageFilter.BoxBlur(radius=2))
            return isinstance(out, Image.Image) and out.size == (128, 128)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(filter_img, images))

        self.assertEqual(len(results), 4)
        self.assertTrue(all(results))

    def test_04_single_thread_regression_safety(self):
        """Verify single-threaded standard execution remains completely functional."""
        A = np.eye(32, dtype=np.float32)
        B = np.ones((32, 32), dtype=np.float32)
        C = np.matmul(A, B)
        self.assertTrue(np.allclose(C, B))

if __name__ == "__main__":
    unittest.main()
