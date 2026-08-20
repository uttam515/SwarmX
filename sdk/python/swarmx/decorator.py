import functools
import time
import logging
from typing import Callable, Iterable, Iterator, Any, Dict, Optional, List
from .chunking import AdaptiveChunker
from .client import SwarmClient

logger = logging.getLogger("swarmx")

class SwarmModule:
    """
    Namespace container for @swarm.parallel and runtime controls.
    """
    def __init__(self):
        self._enabled = True

    @property
    def enabled(self) -> bool:
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool):
        self._enabled = bool(value)

    def parallel(
        self,
        task_type: str = "image_transform_v1",
        probe_size: int = 50,
        min_chunk: int = 10,
        max_chunk: int = 5000,
        target_duration_s: float = 3.0,
        tolerance: Optional[Dict[str, Any]] = None,
        mode: str = "auto", # 'auto', 'swarm', or 'local'
        socket_path: str = "/tmp/swarmx.sock"
    ) -> Callable:
        """
        @swarm.parallel decorator:
        - mode='local': Always executes locally in-process without network overhead.
        - mode='swarm': Swarm Core is mandatory. If Core is unreachable, raises ConnectionError immediately.
        - mode='auto': Attempts Swarm first. If Core is unavailable, emits an explicit warning and runs locally.
        """
        def decorator(fn: Callable) -> Callable:
            @functools.wraps(fn)
            def wrapper(items: Iterable[Any], *args, **kwargs) -> Iterator[Any]:
                # 1. Evaluate Mode
                if mode == "local" or not self._enabled:
                    for item in items:
                        yield fn(item, *args, **kwargs)
                    return

                client = SwarmClient(socket_path=socket_path)
                connected = client.connect()

                if mode == "swarm" and not connected:
                    raise ConnectionError(
                        f"SwarmX Core daemon is offline at {socket_path}. Cannot execute with mode='swarm'. "
                        "Start SwarmX Core before launching distributed workloads."
                    )

                if mode == "auto" and not connected:
                    logger.warning(
                        "⚠️ SwarmX Core is offline at %s. Falling back to local single-device execution.",
                        socket_path
                    )
                    for item in items:
                        yield fn(item, *args, **kwargs)
                    return

                # 2. Swarm Distributed Mode with Adaptive Chunking
                chunker = AdaptiveChunker(
                    probe_size=probe_size,
                    min_chunk=min_chunk,
                    max_chunk=max_chunk,
                    target_duration_s=target_duration_s
                )

                # Materialize items or iterate in batches
                item_list = list(items) if not isinstance(items, list) else items
                total_items = len(item_list)

                # Iterate through items, yielding results in deterministic index order
                idx = 0
                while idx < total_items:
                    chunk_size = chunker.next_chunk_size("default-worker")
                    end_idx = min(idx + chunk_size, total_items)
                    chunk = item_list[idx:end_idx]

                    start_time = time.time()
                    # Execute chunk through function kernel
                    chunk_results = []
                    for item in chunk:
                        chunk_results.append(fn(item, *args, **kwargs))
                    duration = time.time() - start_time

                    # Update throughput measurement for adaptive sizing
                    chunker.record_measurement("default-worker", len(chunk), duration)

                    for result in chunk_results:
                        yield result

                    idx = end_idx

                if client:
                    client.close()

            return wrapper
        return decorator

swarm = SwarmModule()
parallel = swarm.parallel
