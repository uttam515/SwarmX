#!/usr/bin/env python3
"""
========================================================================================
🐝 SwarmX Flagship Demo — Distributed Video Frame Analysis
========================================================================================

Executes the primary flagship workload: 900 sequential video frames partitioned into
30 dynamic chunks scheduled dynamically across available physical Apple Silicon nodes.
"""

import os
import sys

# Add root directory to sys.path to run main demo
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

import demo

if __name__ == "__main__":
    demo.main()
