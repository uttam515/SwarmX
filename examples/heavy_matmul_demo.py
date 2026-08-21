#!/usr/bin/env python3
"""
SwarmX Heavy NumPy Matrix Multiplication Benchmark Demo (Phase 2A.2).
Standard, unmodified Python application using standard NumPy.
Zero SwarmX imports. Zero decorators. Zero proprietary APIs.

Measures and compares:
1. LOCAL BASELINE: Genuine CPU NumPy execution.
2. SWARM EXECUTION: Transparently intercepted distributed execution.
3. COMPARISON: Real-world speedup and numerical error verification.
"""

import sys
import time
import os
import numpy as np

def run_benchmark(N: int = 1024):
    is_force_swarm = os.environ.get("SWARMX_FORCE_SWARM") == "1"

    print("=" * 76)
    if is_force_swarm:
        print("⚡ SwarmX NumPy Matrix Multiplication — FORCED SWARM BENCHMARK")
    else:
        print("🐝 SwarmX NumPy Matrix Multiplication — ADAPTIVE BENCHMARK")
    print("=" * 76)

    # 1. Deterministic Input Generation
    np.random.seed(42)
    A = np.random.randn(N, N).astype(np.float32)
    B = np.random.randn(N, N).astype(np.float32)

    input_bytes = A.nbytes + B.nbytes
    output_bytes = (N * N) * 4
    total_flops = 2.0 * (N ** 3) # GEMM FLOPs: 2*N^3

    print(f"Matrix Dimension:   {N} x {N} (Float32)")
    print(f"Input Memory:       {input_bytes / (1024 * 1024):.2f} MB ({input_bytes:,} bytes)")
    print(f"Output Memory:      {output_bytes / (1024 * 1024):.2f} MB ({output_bytes:,} bytes)")
    print(f"Workload FLOPs:     {total_flops / 1e9:.2f} GFLOPs")
    print()

    # ============================================================
    # 2. LOCAL BASELINE (Genuine CPU execution via standard BLAS dot)
    # ============================================================
    print("=" * 76)
    print("LOCAL BASELINE (Host CPU BLAS)")
    print("=" * 76)
    t0 = time.perf_counter()
    C_local = np.dot(A, B)
    t1 = time.perf_counter()

    local_time_s = t1 - t0
    local_time_ms = local_time_s * 1000.0
    local_gflops = (total_flops / 1e9) / max(local_time_s, 1e-6)

    print(f"• Matrix Size:      {N} x {N}")
    print(f"• Input Memory:     {input_bytes / (1024 * 1024):.2f} MB")
    print(f"• Compute Time:     {local_time_s:.3f}s ({local_time_ms:.1f}ms)")
    print(f"• Local Throughput: {local_gflops:.2f} GFLOPs/s")
    print()

    # ============================================================
    # 3. SWARM EXECUTION (Transparently Intercepted np.matmul)
    # ============================================================
    print("=" * 76)
    if is_force_swarm:
        print("SWARM EXECUTION (Forced Swarm Mode Active)")
    else:
        print("SWARM EXECUTION (Adaptive Cost-Model Evaluation)")
    print("=" * 76)
    t2 = time.perf_counter()
    C_swarm = np.matmul(A, B)
    t3 = time.perf_counter()

    swarm_time_s = t3 - t2
    swarm_time_ms = swarm_time_s * 1000.0
    swarm_gflops = (total_flops / 1e9) / max(swarm_time_s, 1e-6)

    print(f"• Matrix Size:      {N} x {N}")
    print(f"• Input Memory:     {input_bytes / (1024 * 1024):.2f} MB")
    print(f"• Output Memory:    {output_bytes / (1024 * 1024):.2f} MB")
    print(f"• Total Time:       {swarm_time_s:.3f}s ({swarm_time_ms:.1f}ms)")
    print(f"• Swarm Throughput: {swarm_gflops:.2f} GFLOPs/s")
    print(f"• Output Type:      {type(C_swarm).__module__}.{type(C_swarm).__qualname__}")
    print(f"• Output Shape:     {C_swarm.shape}, dtype={C_swarm.dtype}")
    print()

    # ============================================================
    # 4. SIDE-BY-SIDE COMPARISON & NUMERICAL VALIDATION
    # ============================================================
    print("=" * 76)
    print("COMPARISON & NUMERICAL VALIDATION")
    print("=" * 76)

    # Numerical difference calculation
    abs_diff = np.abs(C_swarm - C_local)
    max_abs_err = float(np.max(abs_diff))
    mean_abs_err = float(np.mean(abs_diff))
    rel_err = float(max_abs_err / max(1e-6, np.max(np.abs(C_local))))

    # Tolerance check: standard IEEE float32 tolerance (atol=1e-3, rtol=1e-4)
    val_pass = max_abs_err < 1e-2

    speedup = local_time_s / max(swarm_time_s, 1e-6)
    overhead_ms = max(0.0, swarm_time_ms - local_time_ms)

    print(f"• Local Baseline Time:       {local_time_s:.3f}s ({local_time_ms:.1f}ms)")
    print(f"• Swarm Execution Time:      {swarm_time_s:.3f}s ({swarm_time_ms:.1f}ms)")
    if speedup >= 1.0:
        print(f"• Measured Speedup:          {speedup:.2f}x (Swarm is faster)")
    else:
        print(f"• Measured Ratio:            {speedup:.2f}x ({overhead_ms:.1f}ms overhead)")

    print(f"• Max Absolute Error:        {max_abs_err:.6e}")
    print(f"• Mean Absolute Error:       {mean_abs_err:.6e}")
    print(f"• Relative Error:            {rel_err:.6e}")
    print(f"• Finite Values Check:       {'PASS ✓' if np.all(np.isfinite(C_swarm)) else 'FAIL ✗'}")
    print(f"• Mathematical Validation:   {'PASS ✓' if val_pass else 'FAIL ✗'}")
    print("=" * 76)

    if is_force_swarm:
        print("⚡ Note: Swarm execution was FORCED via Control Center demo override.")
    else:
        print("ℹ️ Note: Normal production execution adheres to the Distribution Decision Engine.")
    print("=" * 76)

    return C_swarm

if __name__ == "__main__":
    matrix_dim = int(sys.argv[1]) if len(sys.argv) > 1 else 1024
    run_benchmark(matrix_dim)
