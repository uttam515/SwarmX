import unittest
from swarmx import swarm

class TestDecorator(unittest.TestCase):
    def test_local_baseline_mode(self):
        @swarm.parallel(mode="local")
        def square_number(x: int) -> int:
            return x * x

        inputs = [1, 2, 3, 4, 5]
        results = list(square_number(inputs))
        self.assertEqual(results, [1, 4, 9, 16, 25])

    def test_deterministic_output_ordering(self):
        @swarm.parallel(probe_size=10, min_chunk=5, max_chunk=50, mode="local")
        def transform_text(text: str) -> str:
            return text.upper()

        inputs = [f"item_{i}" for i in range(100)]
        results = list(transform_text(inputs))

        expected = [f"ITEM_{i}" for i in range(100)]
        self.assertEqual(results, expected)

    def test_disabled_swarm_flag(self):
        swarm.enabled = False

        @swarm.parallel(mode="auto")
        def negate(x: int) -> int:
            return -x

        results = list(negate([10, 20, 30]))
        self.assertEqual(results, [-10, -20, -30])

        swarm.enabled = True

    def test_swarm_mode_mandatory_error_when_offline(self):
        # In mode='swarm', missing Core socket must raise ConnectionError immediately
        @swarm.parallel(mode="swarm", socket_path="/tmp/nonexistent-swarmx-test.sock")
        def process_item(x: int) -> int:
            return x * 2

        with self.assertRaises(ConnectionError):
            list(process_item([1, 2, 3]))

    def test_auto_mode_fallback_when_offline(self):
        # In mode='auto', missing Core socket logs warning and falls back to local execution
        @swarm.parallel(mode="auto", socket_path="/tmp/nonexistent-swarmx-test.sock")
        def process_item(x: int) -> int:
            return x * 3

        results = list(process_item([1, 2, 3]))
        self.assertEqual(results, [3, 6, 9])

if __name__ == "__main__":
    unittest.main()
