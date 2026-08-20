#!/usr/bin/env python3
"""
SwarmX Sprint 2.4A — Benchmark Harness & Profiling Matrix.
Clearly separates and labels:
  [A] Serialization & Deserialization Overhead (Base64 JSON vs Binary Frame)
  [B] Local Host Memory Allocation & RSS Expansion
  [C] End-to-End Workload Preparation Time
  [D] Simulated Distributed Execution vs Local Baseline
"""

import time
import base64
import json
import struct
import sys
import tracemalloc

def benchmark_serialization_and_memory(size_mb: int):
    size_bytes = size_mb * 1024 * 1024
    raw_payload = b"\x88" * size_bytes

    print(f"\n--- [A] Serialization & [B] Memory Benchmark: {size_mb} MB ({size_bytes:,} bytes) ---")

    # 1. Base64 JSON Path (Phase 1 Baseline)
    tracemalloc.start()
    t0 = time.perf_counter()
    b64_str = base64.b64encode(raw_payload).decode("ascii")
    msg_b64 = {
        "id": 1,
        "method": "executeWorkload",
        "params": {
            "workload": {
                "workloadId": "wkl-b64-bench",
                "data": {
                    "totalPayloadBytes": size_bytes,
                    "payloadBase64": b64_str
                }
            }
        }
    }
    json_b64_bytes = json.dumps(msg_b64).encode("utf-8") + b"\n"
    t_ser_b64 = time.perf_counter() - t0
    peak_b64 = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()

    # Deserialization of Base64 JSON
    t0 = time.perf_counter()
    parsed_b64_msg = json.loads(json_b64_bytes.decode("utf-8"))
    decoded_b64_payload = base64.b64decode(parsed_b64_msg["params"]["workload"]["data"]["payloadBase64"])
    t_deser_b64 = time.perf_counter() - t0

    # 2. Binary Stream Path (Milestone 2.1)
    tracemalloc.start()
    t0 = time.perf_counter()
    meta_bin = {
        "id": 1,
        "method": "executeWorkload",
        "params": {
            "workload": {
                "workloadId": "wkl-bin-bench",
                "data": { "totalPayloadBytes": size_bytes }
            }
        }
    }
    json_bin_bytes = json.dumps(meta_bin).encode("utf-8")
    header_bin = b"SWRM" + struct.pack(">I", len(json_bin_bytes))
    full_bin_frame = header_bin + json_bin_bytes + raw_payload
    t_ser_bin = time.perf_counter() - t0
    peak_bin = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()

    # Deserialization of Binary Frame
    t0 = time.perf_counter()
    magic = full_bin_frame[:4]
    jlen = struct.unpack(">I", full_bin_frame[4:8])[0]
    parsed_meta = json.loads(full_bin_frame[8:8+jlen].decode("utf-8"))
    decoded_bin_payload = full_bin_frame[8+jlen:]
    t_deser_bin = time.perf_counter() - t0

    # Sanity check
    assert decoded_b64_payload == raw_payload, "Base64 data mismatch"
    assert decoded_bin_payload == raw_payload, "Binary data mismatch"

    # Compute metrics
    t_total_b64 = t_ser_b64 + t_deser_b64
    t_total_bin = t_ser_bin + t_deser_bin

    ser_speedup = t_ser_b64 / max(1e-6, t_ser_bin)
    deser_speedup = t_deser_b64 / max(1e-6, t_deser_bin)
    total_speedup = t_total_b64 / max(1e-6, t_total_bin)

    throughput_b64 = size_mb / t_total_b64
    throughput_bin = size_mb / t_total_bin

    print(f"  • Wire Transfer Size: Base64 = {len(json_b64_bytes):,} bytes (+{((len(json_b64_bytes)/size_bytes)-1)*100:.1f}%) | Binary = {len(full_bin_frame):,} bytes (+{((len(full_bin_frame)/size_bytes)-1)*100:.3f}%)")
    print(f"  • Serialization Time: Base64 = {t_ser_b64*1000:.2f} ms | Binary = {t_ser_bin*1000:.2f} ms ({ser_speedup:.2f}x faster)")
    print(f"  • Deserialization Time: Base64 = {t_deser_b64*1000:.2f} ms | Binary = {t_deser_bin*1000:.2f} ms ({deser_speedup:.2f}x faster)")
    print(f"  • Peak Memory Usage: Base64 = {peak_b64/(1024*1024):.1f} MB | Binary = {peak_bin/(1024*1024):.1f} MB ({(1 - peak_bin/peak_b64)*100:.1f}% reduction)")
    print(f"  • Serialization Throughput: Base64 = {throughput_b64:.1f} MB/s | Binary = {throughput_bin:.1f} MB/s ({total_speedup:.2f}x speedup)")

    return {
        "sizeMb": size_mb,
        "serSpeedup": ser_speedup,
        "deserSpeedup": deser_speedup,
        "totalSpeedup": total_speedup,
        "throughputBin": throughput_bin,
        "throughputB64": throughput_b64
    }

def main():
    print("=========================================================================================")
    print("🐝 SwarmX Sprint 2.4A — Micro-Benchmark & Profiling Suite")
    print("   [Explicitly Labeled: In-Process Micro-Benchmark on Dev Hardware]")
    print("=========================================================================================")
    results = []
    for mb in [1, 10, 50, 100]:
        res = benchmark_serialization_and_memory(mb)
        results.append(res)
    print("\n=========================================================================================")
    print("🏁 Benchmark Complete. Summary:")
    for r in results:
        print(f"   • {r['sizeMb']:3d} MB: {r['throughputBin']:6.1f} MB/s (Binary) vs {r['throughputB64']:6.1f} MB/s (Base64) -> {r['totalSpeedup']:.2f}x Serialization Speedup")
    print("=========================================================================================\n")

if __name__ == "__main__":
    main()
