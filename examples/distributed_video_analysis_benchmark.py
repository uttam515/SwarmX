#!/usr/bin/env python3
"""
SwarmX Flagship Multi-Worker Distributed Video Frame Analysis Benchmark.

Executes real-time multi-pass scene & motion analysis on 300 sequential video frames:
- Phase 1: Local Single-Device CPU Baseline (1 Mac processes all 300 frames)
- Phase 2: SwarmX 3-Worker Dynamic Work Queue (30 chunks dynamically consumed by physical Macs)
- Phase 3: Per-Frame Numerical & Motion Energy Tolerance Verification
- Phase 4: Truthful Measured Telemetry & Scalability Breakdown
"""

import sys
import os

# Import main demo
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

import demo

if __name__ == "__main__":
    demo.main()
