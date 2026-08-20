"""
SwarmX Runtime Automatic Activation Hook.
Automatically imported by Python's standard `site` module on startup whenever
swarmx is in PYTHONPATH or site-packages.
Installs certified operation interceptors without requiring any user-code imports.
"""
import os

try:
    from swarmx.interceptor import install_interceptor
    install_interceptor()
    if os.environ.get("SWARMX_DEBUG") == "1":
        print("🐝 [SwarmX] Runtime interceptor active (Zero-import transparent mode)")
except Exception:
    # Fail-closed: Never disrupt standard Python startup
    pass
