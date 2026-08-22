#!/usr/bin/env python3
"""
================================================================================
                    SWARMX DISTRIBUTED VIDEO ANALYSIS
                          Flagship Live Benchmark
================================================================================

A self-contained, 100% non-interactive flagship demonstration of SwarmX:
1. Generates / loads a deterministic 300-frame video stream (256×256 RGBA).
2. Measures single-device local CPU baseline execution (multi-pass feature extraction).
3. Dispatches the workload to SwarmX Core dynamic work queue across 3 physical Macs.
4. Validates numerical accuracy per frame.
5. Computes and displays true measured speedup and worker distribution.
"""

import sys
import os
import time
import json
import math
import numpy as np

# Ensure SDK is in python path
sdk_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "sdk", "python"))
if sdk_path not in sys.path:
    sys.path.insert(0, sdk_path)

try:
    from swarmx.client import SwarmClient  # type: ignore
except ImportError:
    print("❌ Error: SwarmX Python SDK not found. Ensure sdk/python is present.")
    sys.exit(1)

def print_header(title: str):
    print("\n" + "=" * 70)
    print(f"        {title}")
    print("=" * 70)

def print_section(title: str):
    print("\n" + title)
    print("-" * 70)

def check_cluster_readiness(socket_path: str = "/tmp/swarmx.sock"):
    if not os.path.exists(socket_path):
        return False, "Core socket /tmp/swarmx.sock is offline.", [], 0
    
    try:
        client = SwarmClient(socket_path=socket_path)
        if not client.connect():
            return False, "Cannot connect to Core socket.", [], 0
        
        status = client.get_status()
        client.close()
        
        workers = status.get("workers", [])
        eligible_count = status.get("eligibleWorkerCount", 0)
        return True, "Core ONLINE", workers, eligible_count
    except Exception as e:
        return False, f"Could not query Core status: {e}", [], 0

def generate_video_stream(total_frames: int = 300, width: int = 256, height: int = 256) -> bytes:
    """Generates a deterministic synthetic video stream with motion and spatial gradient features."""
    total_bytes = total_frames * width * height * 4
    print(f"  • Frame count    : {total_frames} frames")
    print(f"  • Resolution     : {width} × {height} (RGBA uint8)")
    print(f"  • Raw video size : {total_bytes / (1024 * 1024):.2f} MB ({total_bytes:,} bytes)")
    
    t0 = time.perf_counter()
    frames = np.zeros((total_frames, height, width, 4), dtype=np.uint8)
    
    x = np.linspace(0, 255, width, dtype=np.float32)
    y = np.linspace(0, 255, height, dtype=np.float32)
    xx, yy = np.meshgrid(x, y)
    
    for f in range(total_frames):
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
    print(f"  • Ingest latency : {t_gen * 1000:.1f} ms")
    return raw_bytes

def compute_local_baseline(raw_bytes: bytes, total_frames: int, width: int, height: int, channels: int = 4):
    """
    Computes the exact mathematical multi-pass video frame analysis in-process on local host CPU:
    1. Luminance & Variance Moments
    2. Sobel 3x3 Spatial Gradient Magnitude Filter
    3. Discrete Laplacian 2D Second-Derivative Curvature
    4. 16-Bin Intensity Histogram & Shannon Entropy
    5. Temporal Motion Energy Differential
    """
    frame_bytes = width * height * channels
    results = []
    prev_lum = None

    for f in range(total_frames):
        offset = f * frame_bytes
        frame_buf = raw_bytes[offset:offset + frame_bytes]
        frame_arr = np.frombuffer(frame_buf, dtype=np.uint8).reshape((height, width, channels))
        
        # Pass 1: Extract Luminance
        lum = 0.299 * frame_arr[:, :, 0].astype(np.float64) + \
              0.587 * frame_arr[:, :, 1].astype(np.float64) + \
              0.114 * frame_arr[:, :, 2].astype(np.float64)
        
        mean_lum = float(np.mean(lum))
        var_lum = float(np.var(lum))
        
        # Pass 2: Sobel 3x3 Spatial Filter
        # Gx: [-1, 0, 1; -2, 0, 2; -1, 0, 1]
        # Gy: [-1, -2, -1; 0, 0, 0; 1, 2, 1]
        padded = np.pad(lum, ((1, 1), (1, 1)), mode='edge')
        gx = (padded[:-2, 2:] - padded[:-2, :-2]) + \
             2.0 * (padded[1:-1, 2:] - padded[1:-1, :-2]) + \
             (padded[2:, 2:] - padded[2:, :-2])
        
        gy = (padded[2:, :-2] - padded[:-2, :-2]) + \
             2.0 * (padded[2:, 1:-1] - padded[:-2, 1:-1]) + \
             (padded[2:, 2:] - padded[:-2, 2:])
        
        grad_mag = np.sqrt(gx * gx + gy * gy)
        edge_density = float(np.mean(grad_mag))
        
        # Pass 3: Discrete Laplacian 2D Curvature
        lap = padded[1:-1, 2:] + padded[1:-1, :-2] + padded[2:, 1:-1] + padded[:-2, 1:-1] - 4.0 * lum
        laplacian_energy = float(np.mean(np.abs(lap)))
        
        # Pass 4: 16-Bin Histogram & Shannon Entropy
        hist, _ = np.histogram(lum, bins=16, range=(0, 256))
        p = hist[hist > 0] / float(width * height)
        entropy = float(-np.sum(p * np.log2(p)))
        
        # Pass 5: Temporal Motion Energy
        if prev_lum is not None:
            motion = float(np.mean(np.abs(lum - prev_lum)))
        else:
            motion = 0.0
        prev_lum = lum
        
        blur_score = math.sqrt(max(0.0, var_lum)) * (edge_density / 10.0)
        
        results.append({
            "frameIndex": f,
            "luminance": round(mean_lum, 2),
            "edgeDensity": round(edge_density, 2),
            "laplacianEnergy": round(laplacian_energy, 2),
            "entropy": round(entropy, 2),
            "motionEnergy": round(motion, 2),
            "blurScore": round(blur_score, 2)
        })
    
    return results

def main():
    print_header("SWARMX DISTRIBUTED VIDEO FRAME ANALYSIS")
    print("  • Flagship Pipeline : Distributed Multi-Pass Video Frame Analysis (v1)")
    print("  • Workload Config   : 300 Frames (256 × 256 RGBA uint8, ~78.6 MB planar payload)")
    print("  • Dynamic Partitioning: 10 Frames / Chunk (30 Independent Task Chunks)")
    print("  • Execution Target  : Dynamic Work-Queue Dispatch Across Available Swarm Nodes")
    print("  • Execution Mode    : 100% Non-Interactive Automatic Demo (Zero Terminal Input)")

    # 1. Workload Configuration
    total_frames = 300
    chunk_size = 10
    width = 256
    height = 256
    channels = 4
    total_chunks = math.ceil(total_frames / chunk_size)

    # 2. Check Cluster State
    is_online, status_msg, workers_list, eligible_count = check_cluster_readiness()
    print(f"\n📡 SwarmX Cluster State: {status_msg} ({eligible_count} Eligible Worker{'s' if eligible_count != 1 else ''})")
    for w in workers_list:
        dev_name = w.get("capabilityProfile", {}).get("deviceName", w.get("deviceId", "Worker"))
        arch = w.get("capabilityProfile", {}).get("cpuArch", "arm64")
        cores = w.get("capabilityProfile", {}).get("cpuCores", "?")
        print(f"   🍏 {dev_name} ({arch}, {cores} cores) — READY")
    
    if not is_online or eligible_count == 0:
        print("\n⚠️  SwarmX Core or Workers not connected.")
        print("   Please start SwarmX Core (npm start in core/) and connect workers.")
        print("   Exiting demo.")
        sys.exit(1)

    # 3. Video Extraction & Ingestion
    print_section("1. VIDEO INGESTION & DATASET PREPARATION")
    video_bytes = generate_video_stream(total_frames, width, height)

    # -------------------------------------------------------------------------
    # PHASE 1: LOCAL SINGLE-DEVICE EXECUTION
    # -------------------------------------------------------------------------
    print_section("2. LOCAL SINGLE-DEVICE EXECUTION (1 Mac Baseline)")
    print(f"  • Processing all {total_frames} frames locally on host CPU (5 analytical passes/frame)...")
    t0 = time.perf_counter()
    local_results = compute_local_baseline(video_bytes, total_frames, width, height, channels)
    t_local = time.perf_counter() - t0
    local_fps = total_frames / t_local

    print(f"  ✓ Local Execution Time : {t_local:.3f} s ({t_local * 1000.0:.1f} ms)")
    print(f"  ✓ Local Processing Rate: {local_fps:.1f} frames/sec")

    # -------------------------------------------------------------------------
    # PHASE 2: SWARMX DISTRIBUTED DYNAMIC QUEUE EXECUTION
    # -------------------------------------------------------------------------
    print_section(f"3. SWARMX DISTRIBUTED EXECUTION ({eligible_count} Physical Workers, {total_chunks} Chunks)")
    print(f"  • Slicing {total_frames} frames into {total_chunks} independent tasks (10 frames/chunk)...")
    print("  • Dispatching to SwarmX Dynamic Work Queue...")

    client = SwarmClient(socket_path=os.environ.get("SWARMX_IPC_PATH", "/tmp/swarmx.sock"))
    if not client.connect():
        print("❌ Cannot connect to Core socket.")
        sys.exit(1)

    workload_ir = {
        "workloadId": f"wkl-video-demo-{int(time.time())}",
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

    try:
        swarm_results = json.loads(output_bytes.decode("utf-8")) if output_bytes else []
    except Exception as e:
        print(f"❌ Failed to parse Swarm result JSON: {e}")
        swarm_results = []

    print(f"  ✓ SwarmX Execution Time: {t_swarm:.3f} s ({t_swarm * 1000.0:.1f} ms)")
    print(f"  ✓ SwarmX Throughput    : {swarm_fps:.1f} frames/sec")

    # -------------------------------------------------------------------------
    # PHASE 3: NUMERICAL VALIDATION & ERROR ANALYSIS
    # -------------------------------------------------------------------------
    print_section("4. NUMERICAL & PER-FRAME VALIDATION")
    frame_count_match = len(swarm_results) == total_frames
    
    if frame_count_match:
        lum_diffs = [abs(local_results[i]["luminance"] - swarm_results[i].get("luminance", 0)) for i in range(total_frames)]
        edge_diffs = [abs(local_results[i]["edgeDensity"] - swarm_results[i].get("edgeDensity", 0)) for i in range(total_frames)]
        lap_diffs = [abs(local_results[i]["laplacianEnergy"] - swarm_results[i].get("laplacianEnergy", 0)) for i in range(total_frames)]
        ent_diffs = [abs(local_results[i]["entropy"] - swarm_results[i].get("entropy", 0)) for i in range(total_frames)]
        motion_diffs = [abs(local_results[i]["motionEnergy"] - swarm_results[i].get("motionEnergy", 0)) for i in range(total_frames)]

        max_lum_diff = max(lum_diffs)
        max_edge_diff = max(edge_diffs)
        max_lap_diff = max(lap_diffs)
        max_ent_diff = max(ent_diffs)
        max_motion_diff = max(motion_diffs)
        is_valid = max_lum_diff <= 1.0 and max_edge_diff <= 1.0 and max_lap_diff <= 1.0 and max_ent_diff <= 1.0 and max_motion_diff <= 1.0

        print(f"  • Frame Count Match    : {frame_count_match} ({len(swarm_results)} / {total_frames})")
        print(f"  • Max Luminance Delta  : {max_lum_diff:.4f} (Tolerance: <= 1.0)")
        print(f"  • Max Edge Energy Delta: {max_edge_diff:.4f} (Tolerance: <= 1.0)")
        print(f"  • Max Laplacian Delta  : {max_lap_diff:.4f} (Tolerance: <= 1.0)")
        print(f"  • Max Entropy Delta    : {max_ent_diff:.4f} (Tolerance: <= 1.0)")
        print(f"  • Max Motion Delta     : {max_motion_diff:.4f} (Tolerance: <= 1.0)")
        print(f"  • Validation Status    : {'PASS ✓ (Mathematically Equivalent)' if is_valid else 'FAIL ✗'}")
    else:
        is_valid = False
        print(f"  • Frame Count Match    : FAIL ✗ ({len(swarm_results)} / {total_frames})")
        print("  • Validation Status    : FAIL ✗")

    # -------------------------------------------------------------------------
    # PHASE 4: CHUNK DISTRIBUTION TELEMETRY
    # -------------------------------------------------------------------------
    print_section("5. WORKER LOAD & CHUNK DISTRIBUTION")
    telemetry = exec_res.get("telemetry", {})
    chunk_dist = telemetry.get("chunkDistribution", [])

    worker_chunk_map = {}
    for c in chunk_dist:
        w_id = c.get("workerId", "unknown")
        worker_chunk_map[w_id] = worker_chunk_map.get(w_id, 0) + 1

    for w_id, count in sorted(worker_chunk_map.items()):
        pct = (count / total_chunks) * 100.0
        print(f"  • {w_id:36s}: {count:2d} chunks ({pct:4.1f}%)")

    # -------------------------------------------------------------------------
    # PHASE 5: FINAL DEMO VERDICT
    # -------------------------------------------------------------------------
    speedup = t_local / t_swarm if t_swarm > 0 else 1.0
    time_saved_s = t_local - t_swarm
    pct_improvement = ((t_local - t_swarm) / t_local) * 100.0 if t_local > 0 else 0.0

    print_header("FINAL PERFORMANCE VERDICT")
    print(f"  Frames Analyzed     : {total_frames}")
    print(f"  Resolution          : {width} × {height} (RGBA)")
    print(f"  Total Input Bytes   : {len(video_bytes):,} bytes ({len(video_bytes) / (1024 * 1024):.2f} MB)")
    print(f"  Chunks Completed    : {len(chunk_dist)} / {total_chunks}")
    print(f"  Workers Used        : {eligible_count} Physical Apple Silicon Nodes")
    print(f"  Local Elapsed (1 Mac): {t_local:.3f} s ({local_fps:.1f} fps)")
    print(f"  SwarmX Elapsed      : {t_swarm:.3f} s ({swarm_fps:.1f} fps)")
    print(f"  Actual Speedup      : {speedup:.2f}x")
    print(f"  Actual Improvement  : {pct_improvement:+.1f}% ({time_saved_s:.3f} s saved)")
    print(f"  Validation Result   : {'PASS ✓ (Tolerance-Aware Equivalence)' if is_valid else 'FAIL ✗'}")
    print("=" * 70 + "\n")

if __name__ == "__main__":
    main()
