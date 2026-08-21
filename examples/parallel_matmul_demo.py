#!/usr/bin/env python3
"""
SwarmX Parallel / Batch NumPy Matrix Multiplication Demo (Phase 2B).
Standard, unmodified Python application using concurrent.futures and NumPy.
Zero SwarmX imports. Zero decorators. Zero proprietary APIs.

Exercises:
- Multi-threaded concurrent workload dispatch (ThreadPoolExecutor)
- Thread-isolated IPC communication via thread-local client
- Transparent SwarmX distribution across Local Host + cluster workers
- Live batch progress & concurrency telemetry in SwarmX Control Center
"""

import sys
import os
import time
import concurrent.futures
import numpy as np

def generate_workload_pairs(num_tasks: int = 16, dim: int = 512):
    """Generates deterministic Float32 matrix pairs for parallel multiplication."""
    np.random.seed(42)
    pairs = []
    for i in range(num_tasks):
        A = np.random.randn(dim, dim).astype(np.float32)
        B = np.random.randn(dim, dim).astype(np.float32)
        pairs.append((i + 1, A, B))
    return pairs

def run_single_task(task_info):
    task_num, A, B = task_info
    t0 = time.perf_counter()
    # Transparently intercepted np.matmul call on this worker thread
    C = np.matmul(A, B)
    t1 = time.perf_counter()
    duration_ms = (t1 - t0) * 1000.0
    
    # Sanity checks
    is_valid = isinstance(C, np.ndarray) and C.shape == A.shape and np.all(np.isfinite(C))
    return {
        "task_num": task_num,
        "duration_ms": duration_ms,
        "is_valid": is_valid,
        "shape": C.shape,
        "dtype": str(C.dtype),
        "result_sample": float(C[0, 0])
    }

def main():
    num_tasks = int(sys.argv[1]) if len(sys.argv) > 1 else 16
    matrix_dim = int(sys.argv[2]) if len(sys.argv) > 2 else 512
    concurrency = int(sys.argv[3]) if len(sys.argv) > 3 else 4

    is_force_swarm = os.environ.get("SWARMX_FORCE_SWARM") == "1"

    print("=" * 78)
    if is_force_swarm:
        print(f"⚡ SwarmX Concurrent Matrix Multiplication — FORCED SWARM BATCH ({num_tasks} Tasks)")
    else:
        print(f"🐝 SwarmX Concurrent Matrix Multiplication — ADAPTIVE BATCH ({num_tasks} Tasks)")
    print("=" * 78)

    bytes_per_task = (matrix_dim * matrix_dim * 4) * 2
    total_input_mb = (bytes_per_task * num_tasks) / (1024 * 1024)
    total_output_mb = ((matrix_dim * matrix_dim * 4) * num_tasks) / (1024 * 1024)
    flops_per_task = 2.0 * (matrix_dim ** 3)
    total_gflops = (flops_per_task * num_tasks) / 1e9

    print(f"• Total Tasks:        {num_tasks} independent matrix multiplications")
    print(f"• Worker Threads:     {concurrency} concurrent threads (ThreadPoolExecutor)")
    print(f"• Matrix Dimensions:  {matrix_dim} x {matrix_dim} (Float32)")
    print(f"• Total Input Data:   {total_input_mb:.2f} MB ({total_input_mb * 1024 * 1024:,.0f} bytes)")
    print(f"• Total Output Data:  {total_output_mb:.2f} MB ({total_output_mb * 1024 * 1024:,.0f} bytes)")
    print(f"• Total Computation:  {total_gflops:.2f} GFLOPs")
    print("=" * 78)

    print("\n🚀 Dispatching parallel workload batch across SwarmX cluster...")
    pairs = generate_workload_pairs(num_tasks, matrix_dim)

    batch_start = time.perf_counter()
    completed_results = []
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = {executor.submit(run_single_task, pair): pair[0] for pair in pairs}
        for future in concurrent.futures.as_completed(futures):
            res = future.result()
            completed_results.append(res)
            status_symbol = "✓" if res["is_valid"] else "✗"
            print(f"  [{len(completed_results):02d}/{num_tasks:02d}] Task #{res['task_num']:02d} completed in {res['duration_ms']:6.1f}ms [{status_symbol} Valid ndarray {res['shape']}]")

    batch_end = time.perf_counter()
    total_batch_time_s = batch_end - batch_start
    total_batch_time_ms = total_batch_time_s * 1000.0

    # Sort results by task number for clean reporting
    completed_results.sort(key=lambda r: r["task_num"])
    successful_count = sum(1 for r in completed_results if r["is_valid"])
    failed_count = num_tasks - successful_count
    avg_task_ms = sum(r["duration_ms"] for r in completed_results) / num_tasks
    throughput_tasks_sec = num_tasks / max(total_batch_time_s, 1e-6)
    throughput_gflops_sec = total_gflops / max(total_batch_time_s, 1e-6)

    print("\n" + "=" * 78)
    print("PARALLEL BATCH SUMMARY")
    print("=" * 78)
    print(f"• Completed Tasks:        {successful_count}/{num_tasks} ({failed_count} failed)")
    print(f"• Total Batch Time:       {total_batch_time_s:.3f}s ({total_batch_time_ms:.1f}ms)")
    print(f"• Average Task Time:      {avg_task_ms:.1f}ms")
    print(f"• Concurrency Level:      {concurrency} threads")
    print(f"• Batch Throughput:       {throughput_tasks_sec:.2f} tasks/sec")
    print(f"• Computational Rate:     {throughput_gflops_sec:.2f} GFLOPs/s")
    print(f"• Mathematical Validity:  {'ALL PASSED (100% Valid NumPy ndarrays) ✓' if failed_count == 0 else 'FAIL ✗'}")
    print("=" * 78)

    if is_force_swarm:
        print("⚡ Note: Distributed execution was FORCED via Control Center demo override.")
    else:
        print("ℹ️ Note: Workload distribution followed the Distribution Decision Engine.")
    print("=" * 78)

if __name__ == "__main__":
    main()
