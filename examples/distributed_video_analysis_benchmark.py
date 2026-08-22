#!/usr/bin/env python3
"""
SwarmX Flagship Multi-Worker Distributed Video Frame Analysis Benchmark.

Executes real-time multi-frame scene & motion analysis on 900 sequential video frames:
- Phase 1: Local Single-Device CPU Baseline (1 Mac processes all 900 frames)
- Phase 2: SwarmX 3-Worker Dynamic Work Queue (30 chunks dynamically consumed by 3 physical Macs)
- Phase 3: Per-Frame Numerical & Motion Energy Tolerance Verification
- Phase 4: Truthful Measured Telemetry & Scalability Breakdown
"""

import sys
import os
import time
import json
import math
import numpy as np

# Ensure SDK is in path
sdk_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "sdk", "python"))
if sdk_path not in sys.path:
    sys.path.insert(0, sdk_path)

try:
    from swarmx.client import SwarmClient  # type: ignore
except ImportError:
    SwarmClient = None  # type: ignore

def check_core_status():
    socket_path = os.environ.get("SWARMX_IPC_PATH", "/tmp/swarmx.sock")
    if not os.path.exists(socket_path):
        return False, "Core socket /tmp/swarmx.sock is offline.", 0
    
    try:
        client = SwarmClient(socket_path=socket_path)
        if not client.connect():
            return False, f"Cannot connect to Core socket at {socket_path}", 0
        
        status = client.get_status()
        client.close()
        
        eligible_workers = status.get("eligibleWorkerCount", 0)
        return True, f"Core online with {eligible_workers} eligible worker(s).", eligible_workers
    except Exception as e:
        return False, f"Could not query Core status: {e}", 0

def generate_video_frames(total_frames: int = 900, width: int = 512, height: int = 512) -> bytes:
    """
    Generates a deterministic synthetic video stream with simulated motion and spatial patterns.
    Each frame contains dynamic moving gradients, simulated camera pan, and edge features.
    """
    print(f"📦 Generating {total_frames} frames ({width}×{height} RGBA)...")
    t0 = time.perf_counter()
    
    # Preallocate contiguous array: [total_frames, height, width, 4]
    frames = np.zeros((total_frames, height, width, 4), dtype=np.uint8)
    
    x = np.linspace(0, 255, width, dtype=np.float32)
    y = np.linspace(0, 255, height, dtype=np.float32)
    xx, yy = np.meshgrid(x, y)
    
    for f in range(total_frames):
        # Moving spatial wave pattern
        shift = (f * 4) % 256
        r = ((xx + shift) % 256).astype(np.uint8)
        g = ((yy + shift * 2) % 256).astype(np.uint8)
        b = ((xx * 0.5 + yy * 0.5 + shift) % 256).astype(np.uint8)
        
        frames[f, :, :, 0] = r
        frames[f, :, :, 1] = g
        frames[f, :, :, 2] = b
        frames[f, :, :, 3] = 255

    raw_bytes = frames.tobytes()
    t_gen = time.perf_counter() - t0
    print(f"  ✓ Generated {(len(raw_bytes)/(1024*1024)):.2f} MB in {t_gen:.2f}s")
    return raw_bytes

def compute_local_video_analysis(raw_bytes: bytes, total_frames: int, width: int, height: int, channels: int = 4):
    """
    Computes single-device reference analysis in local process.
    Matches the exact computation performed by the native Swift worker.
    """
    frame_bytes = width * height * channels
    results = []
    prev_frame = None

    for f in range(total_frames):
        offset = f * frame_bytes
        frame_buf = raw_bytes[offset:offset + frame_bytes]
        frame_arr = np.frombuffer(frame_buf, dtype=np.uint8).reshape((height, width, channels))
        
        # Luminance
        lum = 0.299 * frame_arr[:, :, 0] + 0.587 * frame_arr[:, :, 1] + 0.114 * frame_arr[:, :, 2]
        mean_lum = float(np.mean(lum))
        var_lum = float(np.var(lum))
        
        # Edge energy (Sobel-like gradient delta)
        dx = np.abs(np.diff(lum, axis=1, append=lum[:, -1:]))
        dy = np.abs(np.diff(lum, axis=0, append=lum[-1:, :]))
        edge_density = float(np.mean(dx + dy))
        
        # Motion energy relative to previous frame
        if prev_frame is not None:
            motion = float(np.mean(np.abs(lum - prev_frame)))
        else:
            motion = 0.0
        prev_frame = lum
        
        blur_score = math.sqrt(max(0.0, var_lum)) * (edge_density / 10.0)
        
        results.append({
            "frameIndex": f,
            "luminance": round(mean_lum, 2),
            "edgeDensity": round(edge_density, 2),
            "motionEnergy": round(motion, 2),
            "blurScore": round(blur_score, 2)
        })
    
    return results

def run_benchmark():
    # 1. Benchmark Configuration
    total_frames = int(sys.argv[1]) if len(sys.argv) > 1 else 900
    chunk_size = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    width = 512
    height = 512
    channels = 4
    total_chunks = math.ceil(total_frames / chunk_size)
    payload_mb = (total_frames * width * height * channels) / (1024 * 1024)

    print("=" * 80)
    print("🐝 SwarmX Flagship Multi-Worker Distributed Video Frame Analysis Benchmark")
    print("=" * 80)
    print(f"• Total Video Frames: {total_frames} frames ({width} × {height} RGBA)")
    print(f"• Chunk Granularity:  {chunk_size} frames/chunk → {total_chunks} independent queue chunks")
    print(f"• Total Video Data:   {payload_mb:.2f} MB In / ~1 KB JSON Out")
    print("-" * 80)

    # 2. Check SwarmX Cluster State
    is_online, status_msg, worker_count = check_core_status()
    print(f"📡 SwarmX Cluster State: {status_msg}")

    # 3. Generate Video Data
    video_bytes = generate_video_frames(total_frames, width, height)

    # -------------------------------------------------------------------------
    # PHASE 1: LOCAL BASELINE (1 Host Single-Device Execution)
    # -------------------------------------------------------------------------
    print("\n[PHASE 1] Measuring Local Single-Device Host CPU Baseline...")
    t0 = time.perf_counter()
    local_results = compute_local_video_analysis(video_bytes, total_frames, width, height, channels)
    t_local = time.perf_counter() - t0
    local_fps = total_frames / t_local

    print(f"  ✓ Local Host Wall Time:   {t_local * 1000.0:.2f} ms ({t_local:.4f} s)")
    print(f"  ✓ Local Host Throughput:  {local_fps:.2f} frames/sec")
    print(f"  ✓ Analyzed Frames:        {len(local_results)} / {total_frames}")

    # -------------------------------------------------------------------------
    # PHASE 2: SWARMX DISTRIBUTED DYNAMIC QUEUE EXECUTION
    # -------------------------------------------------------------------------
    if not is_online:
        print("\n[PHASE 2] SKIPPED: SwarmX Core is offline.")
        return

    print("\n[PHASE 2] Measuring SwarmX Multi-Worker Dynamic Work Queue Execution...")
    client = SwarmClient(socket_path=os.environ.get("SWARMX_IPC_PATH", "/tmp/swarmx.sock"))
    if not client.connect():
        print("❌ Cannot connect to Core socket.")
        return

    workload_ir = {
        "workloadId": f"wkl-video-benchmark-{int(time.time())}",
        "version": "1.0.0",
        "computation": {
            "domain": "IMAGE_PROCESSING",
            "kernelId": "video_frame_analysis_v1",
            "parameters": {
                "width": width,
                "height": height,
                "channels": channels,
                "mode": "RGBA",
                "totalFrames": total_frames,
                "chunkSize": chunk_size,
                "chunks": total_chunks
            }
        },
        "data": {
            "itemCount": total_frames,
            "totalPayloadBytes": len(video_bytes),
            "format": "RAW_PLANAR_RGBA_UINT8"
        },
        "constraints": {
            "isPure": True,
            "isIdempotent": True,
            "toleranceValidator": "NUMERIC_TOLERANCE"
        }
    }

    t0 = time.perf_counter()
    exec_res, output_bytes = client.execute_workload_binary(workload_ir, video_bytes, force_swarm=True)
    t_swarm = time.perf_counter() - t0
    swarm_fps = total_frames / t_swarm

    client.close()

    print(f"  ✓ Swarm Cluster Wall Time:{t_swarm * 1000.0:.2f} ms ({t_swarm:.4f} s)")
    print(f"  ✓ Swarm Cluster Throughput:{swarm_fps:.2f} frames/sec")
    print(f"  ✓ Execution Status:       {exec_res.get('status')}")

    # -------------------------------------------------------------------------
    # PHASE 3: NUMERICAL & PER-FRAME VALIDATION
    # -------------------------------------------------------------------------
    print("\n[PHASE 3] Numerical & Per-Frame Result Validation...")
    try:
        swarm_results = json.loads(output_bytes.decode("utf-8")) if output_bytes else []
    except Exception as e:
        print(f"❌ Failed to parse Swarm result JSON: {e}")
        swarm_results = []

    frame_count_match = len(swarm_results) == total_frames
    print(f"  • Frame Count Equality:    {frame_count_match} ({len(swarm_results)} / {total_frames})")

    lum_diffs = []
    edge_diffs = []
    motion_diffs = []

    if frame_count_match:
        for i in range(total_frames):
            loc = local_results[i]
            swm = swarm_results[i]
            lum_diffs.append(abs(loc["luminance"] - swm.get("luminance", 0)))
            edge_diffs.append(abs(loc["edgeDensity"] - swm.get("edgeDensity", 0)))
            motion_diffs.append(abs(loc["motionEnergy"] - swm.get("motionEnergy", 0)))

        max_lum_diff = max(lum_diffs) if lum_diffs else 0
        max_edge_diff = max(edge_diffs) if edge_diffs else 0
        max_motion_diff = max(motion_diffs) if motion_diffs else 0
        is_valid = max_lum_diff <= 1.0 and max_edge_diff <= 1.0 and max_motion_diff <= 1.0

        print(f"  • Max Luminance Delta:     {max_lum_diff:.4f} (Tolerance: <= 1.0)")
        print(f"  • Max Edge Density Delta:  {max_edge_diff:.4f} (Tolerance: <= 1.0)")
        print(f"  • Max Motion Energy Delta: {max_motion_diff:.4f} (Tolerance: <= 1.0)")
        print(f"  • Frame Validation Result: {'PASS ✓' if is_valid else 'FAIL ✗'}")
    else:
        is_valid = False
        print("  • Frame Validation Result: FAIL ✗ (Missing frames)")

    # -------------------------------------------------------------------------
    # PHASE 4: CHUNK DISTRIBUTION & TELEMETRY BREAKDOWN
    # -------------------------------------------------------------------------
    telemetry = exec_res.get("telemetry", {})
    chunk_dist = telemetry.get("chunkDistribution", [])

    worker_chunk_map = {}
    for c in chunk_dist:
        w_id = c.get("workerId", "unknown")
        worker_chunk_map[w_id] = worker_chunk_map.get(w_id, 0) + 1

    print("\n" + "-" * 80)
    print("📍 DYNAMIC WORK QUEUE DISTRIBUTION ACROSS CLUSTER")
    print("-" * 80)
    for w_id, count in sorted(worker_chunk_map.items()):
        pct = (count / total_chunks) * 100.0
        print(f"  • Worker {w_id[:32]:32s}: {count:2d} chunks ({pct:4.1f}% of workload)")

    # -------------------------------------------------------------------------
    # PHASE 5: BENCHMARK SUMMARY & SPEEDUP VERDICT
    # -------------------------------------------------------------------------
    speedup = t_local / t_swarm
    time_saved_ms = (t_local - t_swarm) * 1000.0
    pct_improvement = ((t_local - t_swarm) / t_local) * 100.0

    print("\n" + "=" * 80)
    print("📊 BENCHMARK VERDICT & SUMMARY (MEASURED)")
    print("=" * 80)
    print(f"  • Local Single-Device Host:{t_local * 1000.0:8.2f} ms ({local_fps:.1f} fps)")
    print(f"  • SwarmX Dynamic Cluster: {t_swarm * 1000.0:8.2f} ms ({swarm_fps:.1f} fps)")
    print(f"  • Measured Speedup:       {speedup:.2f}x")
    print(f"  • Net Time Saved:         {time_saved_ms:.2f} ms")
    print(f"  • Net Performance Gain:   {pct_improvement:+.1f}%")
    print(f"  • Validation Status:      {'PASS ✓' if is_valid else 'FAIL ✗'}")
    print("=" * 80)

if __name__ == "__main__":
    run_benchmark()
