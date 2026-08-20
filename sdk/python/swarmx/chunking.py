import math
from typing import Dict, List, Any, Iterator, Iterable

class AdaptiveChunker:
    """
    Adaptive Chunk Sizing Engine (Phase 1):
    - Emits an initial small probe chunk per worker to measure baseline execution throughput.
    - Dynamically resizes subsequent chunks based on observed items/sec targeting a constant chunk duration (e.g. 3s).
    - Clamps chunk sizes within [min_chunk, max_chunk] boundaries.
    """
    def __init__(
        self,
        probe_size: int = 50,
        min_chunk: int = 10,
        max_chunk: int = 5000,
        target_duration_s: float = 3.0,
        ema_alpha: float = 0.7
    ):
        self.probe_size = probe_size
        self.min_chunk = min_chunk
        self.max_chunk = max_chunk
        self.target_duration_s = target_duration_s
        self.ema_alpha = ema_alpha
        self.worker_throughput_ema: Dict[str, float] = {} # worker_id -> items/sec

    def record_measurement(self, worker_id: str, item_count: int, duration_s: float) -> float:
        """
        Records completed chunk duration and updates worker throughput EMA.
        Returns the updated throughput (items/sec).
        """
        if duration_s <= 0 or item_count <= 0:
            return self.worker_throughput_ema.get(worker_id, 0.0)

        measured_rate = item_count / duration_s
        if worker_id in self.worker_throughput_ema:
            prior = self.worker_throughput_ema[worker_id]
            updated = (self.ema_alpha * measured_rate) + ((1.0 - self.ema_alpha) * prior)
        else:
            updated = measured_rate

        self.worker_throughput_ema[worker_id] = updated
        return updated

    def next_chunk_size(self, worker_id: str) -> int:
        """
        Calculates the next chunk size for a worker.
        Returns probe_size if no prior measurement exists, otherwise dynamically scaled size.
        """
        if worker_id not in self.worker_throughput_ema:
            return max(self.min_chunk, min(self.probe_size, self.max_chunk))

        throughput = self.worker_throughput_ema[worker_id]
        ideal_size = int(math.ceil(throughput * self.target_duration_s))
        return max(self.min_chunk, min(ideal_size, self.max_chunk))

    def get_worker_throughput(self, worker_id: str) -> float:
        return self.worker_throughput_ema.get(worker_id, 0.0)

    @staticmethod
    def slice_iterable(items: Iterable[Any], chunk_size: int) -> Iterator[List[Any]]:
        """
        Yields consecutive chunks of chunk_size from an iterable.
        """
        chunk = []
        for item in items:
            chunk.append(item)
            if len(chunk) >= chunk_size:
                yield chunk
                chunk = []
        if chunk:
            yield chunk
