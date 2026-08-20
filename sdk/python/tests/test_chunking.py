import unittest
from swarmx.chunking import AdaptiveChunker

class TestAdaptiveChunker(unittest.TestCase):
    def test_initial_probe_size(self):
        chunker = AdaptiveChunker(probe_size=50, min_chunk=10, max_chunk=1000)
        # First chunk for any new worker must be probe_size
        self.assertEqual(chunker.next_chunk_size("worker-mac-01"), 50)
        self.assertEqual(chunker.next_chunk_size("worker-win-02"), 50)

    def test_dynamic_throughput_resizing(self):
        chunker = AdaptiveChunker(probe_size=50, min_chunk=10, max_chunk=5000, target_duration_s=3.0)
        
        # Worker 1 processes 50 items in 0.1s -> 500 items/s
        # Next ideal chunk = 500 * 3.0 = 1500 items
        chunker.record_measurement("worker-fast", 50, 0.10)
        next_size = chunker.next_chunk_size("worker-fast")
        self.assertEqual(next_size, 1500)

        # Worker 2 processes 50 items in 2.5s -> 20 items/s
        # Next ideal chunk = 20 * 3.0 = 60 items
        chunker.record_measurement("worker-slow", 50, 2.5)
        next_size_slow = chunker.next_chunk_size("worker-slow")
        self.assertEqual(next_size_slow, 60)

    def test_clamp_boundaries(self):
        chunker = AdaptiveChunker(probe_size=50, min_chunk=20, max_chunk=500, target_duration_s=3.0)

        # Extremely fast worker -> Clamped to max_chunk (500)
        chunker.record_measurement("worker-super", 50, 0.001) # 50,000 items/s
        self.assertEqual(chunker.next_chunk_size("worker-super"), 500)

        # Extremely slow worker -> Clamped to min_chunk (20)
        chunker.record_measurement("worker-crawler", 50, 50.0) # 1 item/s
        self.assertEqual(chunker.next_chunk_size("worker-crawler"), 20)

    def test_slice_iterable(self):
        items = list(range(105))
        chunks = list(AdaptiveChunker.slice_iterable(items, 50))
        self.assertEqual(len(chunks), 3)
        self.assertEqual(len(chunks[0]), 50)
        self.assertEqual(len(chunks[1]), 50)
        self.assertEqual(len(chunks[2]), 5)

if __name__ == "__main__":
    unittest.main()
