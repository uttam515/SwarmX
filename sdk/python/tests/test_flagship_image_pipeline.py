import unittest
import time
import math
from swarmx.chunking import AdaptiveChunker
from swarmx import parallel

def local_image_filter(image_pixel_array):
    """Deterministic reference image kernel: 3x3 box blur / normalization."""
    result = []
    for pixel in image_pixel_array:
        # Greyscale normalization + contrast curve
        val = int(round(pixel * 0.95 + 5.0))
        result.append(min(255, max(0, val)))
    return result

class TestFlagshipImagePipeline(unittest.TestCase):
    def setUp(self):
        # Generate deterministic synthetic image dataset of 100 images (each 16x16 = 256 pixels)
        self.synthetic_images = []
        for i in range(100):
            pixels = [(i * 7 + p * 13) % 256 for p in range(256)]
            self.synthetic_images.append(pixels)

    def test_local_baseline_vs_parallel_deterministic_equivalence(self):
        # 1. Compute local ground truth baseline
        t0 = time.perf_counter()
        baseline_results = [local_image_filter(img) for img in self.synthetic_images]
        t_baseline = time.perf_counter() - t0

        # 2. Compute via @swarm.parallel in mode="local" (deterministic in-process pipeline)
        @parallel(mode="local", target_duration_s=1.0)
        def parallel_filter(image):
            return local_image_filter(image)

        t1 = time.perf_counter()
        parallel_results = list(parallel_filter(self.synthetic_images))
        t_parallel = time.perf_counter() - t1

        # 3. Assert exact count and deterministic ordering
        self.assertEqual(len(parallel_results), 100)
        self.assertEqual(len(parallel_results), len(baseline_results))

        # 4. Assert pixel-wise equivalence and tolerance
        max_delta = 0
        total_sq_err = 0
        total_pixels = 0

        for b_img, p_img in zip(baseline_results, parallel_results):
            self.assertEqual(len(b_img), len(p_img))
            for b_px, p_px in zip(b_img, p_img):
                diff = abs(b_px - p_px)
                if diff > max_delta:
                    max_delta = diff
                total_sq_err += (b_px - p_px) ** 2
                total_pixels += 1

        mse = total_sq_err / total_pixels
        self.assertEqual(max_delta, 0, "Deterministic baseline must match exactly")
        self.assertEqual(mse, 0.0)

    def test_adaptive_chunking_telemetry_progression(self):
        """Verify probe chunk -> measured throughput -> EMA throughput -> next chunk size progression."""
        chunker = AdaptiveChunker(probe_size=10, min_chunk=5, max_chunk=50, target_duration_s=2.0)
        worker_id = "test-worker-mac"

        # 1. Initial probe chunk size
        probe = chunker.next_chunk_size(worker_id)
        self.assertEqual(probe, 10, "Initial chunk must equal probe_size")

        # 2. Worker completes probe of 10 images in 0.20s (50 items/sec)
        chunker.record_measurement(worker_id, 10, 0.20)
        throughput_1 = chunker.get_worker_throughput(worker_id)
        self.assertAlmostEqual(throughput_1, 50.0, places=1)

        # Next chunk for 2.0s target duration = 50 * 2.0 = 100 -> clamped to max_chunk (50)
        next_chunk_1 = chunker.next_chunk_size(worker_id)
        self.assertEqual(next_chunk_1, 50)

        # 3. Worker completes 50 images in 2.5s (20 items/sec)
        chunker.record_measurement(worker_id, 50, 2.50)
        throughput_2 = chunker.get_worker_throughput(worker_id)
        # EMA: 0.7 * 20.0 + 0.3 * 50.0 = 14.0 + 15.0 = 29.0 items/sec
        self.assertAlmostEqual(throughput_2, 29.0, places=1)

        # Next chunk for 2.0s = 29.0 * 2.0 = 58 -> clamped to max_chunk (50)
        next_chunk_2 = chunker.next_chunk_size(worker_id)
        self.assertEqual(next_chunk_2, 50)

if __name__ == "__main__":
    unittest.main()
