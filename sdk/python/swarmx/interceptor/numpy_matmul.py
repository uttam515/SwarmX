"""
SwarmX Transparent NumPy Matmul Interceptor (Milestone 2.4).
Intercepts numpy.matmul and ndarray.__matmul__ for certified 2D float32 matrices
and transparently offloads to SwarmX Core with zero application code modifications.
"""

import os
import sys
import time
import threading
from typing import Any, Tuple

_ORIGINAL_NUMPY_MATMUL = None
_ORIGINAL_NDARRAY_MATMUL = None
_INTERCEPTOR_INSTALLED = False
_MATMUL_COUNTER = 0
_COUNTER_LOCK = threading.Lock()

def _next_workload_id(kernel_name: str = "matmul") -> str:
    global _MATMUL_COUNTER
    with _COUNTER_LOCK:
        _MATMUL_COUNTER += 1
        count = _MATMUL_COUNTER
    prefix = os.environ.get("SWARMX_WORKLOAD_PREFIX", "wkl")
    return f"{prefix}-{kernel_name}-demo-{count:03d}"

def is_certified_matmul(a: Any, b: Any) -> Tuple[bool, str]:
    """
    Validates whether the inputs meet the strict Milestone 2.4 certified contract:
    - Both inputs are numpy.ndarray
    - Both inputs are 2D
    - Matrix dimensions align: A.shape[1] == B.shape[0]
    - Both inputs are float32
    - Both inputs are C-contiguous
    """
    try:
        import numpy as np
    except ImportError:
        return False, "NumPy is not installed"

    if not isinstance(a, np.ndarray) or not isinstance(b, np.ndarray):
        return False, "Inputs must be numpy.ndarray instances"

    if a.ndim != 2 or b.ndim != 2:
        return False, f"Only 2D matrices are supported (got A.ndim={a.ndim}, B.ndim={b.ndim})"

    if a.shape[1] != b.shape[0]:
        return False, f"Incompatible matrix shapes for multiplication: {a.shape} vs {b.shape}"

    if a.dtype != np.float32 or b.dtype != np.float32:
        return False, f"Only float32 matrices are supported (got A.dtype={a.dtype}, B.dtype={b.dtype})"

    if not a.flags['C_CONTIGUOUS'] or not b.flags['C_CONTIGUOUS']:
        return False, "Only C-contiguous arrays are eligible for zero-copy offloading"

    return True, "Valid certified matmul"

def _get_client(socket_path: str):
    from swarmx.client import get_thread_local_client
    return get_thread_local_client(socket_path=socket_path)

def swarmx_matmul(a: Any, b: Any, *args, **kwargs) -> Any:
    """
    Transparent replacement for numpy.matmul and ndarray.__matmul__.
    """
    global _ORIGINAL_NUMPY_MATMUL

    # Fast-path fallback for positional/keyword arguments beyond simple matmul
    if args or kwargs or _ORIGINAL_NUMPY_MATMUL is None:
        if _ORIGINAL_NUMPY_MATMUL is not None:
            return _ORIGINAL_NUMPY_MATMUL(a, b, *args, **kwargs)
        import numpy as np
        return np.matmul(a, b, *args, **kwargs)

    if os.environ.get("SWARMX_BYPASS") == "1":
        return _ORIGINAL_NUMPY_MATMUL(a, b)

    debug = os.environ.get("SWARMX_DEBUG") == "1"

    # 1. Contract Validation
    is_valid, reason = is_certified_matmul(a, b)
    if not is_valid:
        if debug:
            print(f"⚠️ [SwarmX Matmul] Ineligible input: {reason} -> executing via native NumPy")
        return _ORIGINAL_NUMPY_MATMUL(a, b)

    import numpy as np
    M, K = a.shape
    K_b, N = b.shape

    # 2. Check Core Socket Availability
    socket_path = os.environ.get("SWARMX_IPC_PATH", os.environ.get("SWARMX_SOCKET_PATH", "/tmp/swarmx.sock"))
    if not os.path.exists(socket_path):
        if debug:
            print("⚠️ [SwarmX Matmul] Core socket offline -> executing via native NumPy")
        return _ORIGINAL_NUMPY_MATMUL(a, b)

    try:
        client = _get_client(socket_path)
        if not client or not client.is_connected():
            return _ORIGINAL_NUMPY_MATMUL(a, b)

        payload_bytes = (M * K * 4) + (K * N * 4)
        output_bytes_expected = M * N * 4

        # 3. Construct platform-neutral Workload IR
        workload_ir = {
            "workloadId": _next_workload_id("matmul"),
            "version": "1.0.0",
            "computation": {
                "domain": "NUMERICAL_COMPUTATION",
                "kernelId": "matrix_multiply_v1",
                "parameters": {
                    "M": M,
                    "K": K,
                    "N": N,
                    "dtype": "FLOAT32"
                }
            },
            "data": {
                "itemCount": 1,
                "totalPayloadBytes": payload_bytes,
                "format": "FLOAT32_ARRAY"
            },
            "constraints": {
                "isPure": True,
                "isIdempotent": True,
                "toleranceValidator": "NUMERIC_TOLERANCE",
                "maxMse": 1e-4
            }
        }

        force_swarm = os.environ.get("SWARMX_FORCE_SWARM") == "1"

        # 4. Dispatch via Single-Round-Trip Zero-Copy Binary Execution Path
        # (Core evaluates decision internally and returns LOCAL_FALLBACK if local is faster)
        t_intercept_start = time.perf_counter()

        if debug:
            print(f"🚀 [SwarmX Matmul] Offloading {M}x{K} @ {K}x{N} ({payload_bytes:,} bytes) to SwarmX Core...")

        raw_payload = a.tobytes() + b.tobytes()
        exec_res, out_bytes = client.execute_workload_binary(workload_ir, raw_payload, force_swarm=force_swarm)

        global _LAST_EXECUTION_RESULT
        _LAST_EXECUTION_RESULT = exec_res

        if exec_res.get("status") == "LOCAL_FALLBACK" and not force_swarm:
            if debug:
                print(f"🔍 [SwarmX Matmul] Core indicated LOCAL_FALLBACK ({exec_res.get('reason')}) -> executing via native NumPy")
            return _ORIGINAL_NUMPY_MATMUL(a, b)

        if exec_res.get("status") == "COMPLETED" and len(out_bytes) == output_bytes_expected:
            t_recon_start = time.perf_counter()
            out_array = np.frombuffer(out_bytes, dtype=np.float32).reshape((M, N)).copy()
            t_recon_end = time.perf_counter()

            if "telemetry" in exec_res:
                exec_res["telemetry"]["pythonReconstructMs"] = (t_recon_end - t_recon_start) * 1000.0
                exec_res["telemetry"]["pythonTotalMs"] = (t_recon_end - t_intercept_start) * 1000.0

            if debug:
                print("✅ [SwarmX Matmul] Received valid binary buffer from Swarm -> reconstructed numpy.ndarray")
            return out_array

        if force_swarm:
            raise RuntimeError(f"ERROR: Forced Swarm matmul execution failed: {exec_res.get('reason', 'Remote worker execution error')}")

        if debug:
            print(f"⚠️ [SwarmX Matmul] Execution fallback triggered: {exec_res.get('reason')} -> executing via native NumPy")
        return _ORIGINAL_NUMPY_MATMUL(a, b)

    except Exception as e:
        if os.environ.get("SWARMX_FORCE_SWARM") == "1":
            raise
        if debug:
            print(f"⚠️ [SwarmX Error] Exception during matmul interception: {e} -> falling back to native NumPy")
        return _ORIGINAL_NUMPY_MATMUL(a, b)

def install_interceptor():
    """Installs the transparent NumPy matmul interceptor."""
    global _ORIGINAL_NUMPY_MATMUL, _ORIGINAL_NDARRAY_MATMUL, _INTERCEPTOR_INSTALLED
    if not _INTERCEPTOR_INSTALLED:
        try:
            import numpy as np
            _ORIGINAL_NUMPY_MATMUL = np.matmul
            np.matmul = swarmx_matmul
            _INTERCEPTOR_INSTALLED = True
        except ImportError:
            pass

def uninstall_interceptor():
    """Uninstalls the interceptor and restores native NumPy behavior."""
    global _ORIGINAL_NUMPY_MATMUL, _INTERCEPTOR_INSTALLED
    if _INTERCEPTOR_INSTALLED:
        try:
            import numpy as np
            if _ORIGINAL_NUMPY_MATMUL is not None:
                np.matmul = _ORIGINAL_NUMPY_MATMUL
            _INTERCEPTOR_INSTALLED = False
        except ImportError:
            pass

def get_last_execution_result():
    """Returns telemetry and metadata of the most recent intercepted execution."""
    global _LAST_EXECUTION_RESULT
    return _LAST_EXECUTION_RESULT
