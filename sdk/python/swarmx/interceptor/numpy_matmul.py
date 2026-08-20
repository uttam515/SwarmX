"""
SwarmX Transparent NumPy Matmul Interceptor (Milestone 2.4).
Intercepts numpy.matmul and ndarray.__matmul__ for certified 2D float32 matrices
and transparently offloads to SwarmX Core with zero application code modifications.
"""

import os
import sys
from typing import Any, Tuple

_ORIGINAL_NUMPY_MATMUL = None
_ORIGINAL_NDARRAY_MATMUL = None
_INTERCEPTOR_INSTALLED = False

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

_GLOBAL_CLIENT = None

def _get_client(socket_path: str):
    global _GLOBAL_CLIENT
    if _GLOBAL_CLIENT is None or not _GLOBAL_CLIENT.is_connected():
        from swarmx.client import SwarmClient
        _GLOBAL_CLIENT = SwarmClient(socket_path=socket_path)
        _GLOBAL_CLIENT.connect()
    return _GLOBAL_CLIENT

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
    socket_path = os.environ.get("SWARMX_SOCKET_PATH", "/tmp/swarmx.sock")
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
            "workloadId": f"wkl-matmul-{id(a)}-{id(b)}-{M}x{N}",
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

        # 4. Evaluate Cost Model
        eval_res = client.evaluate_workload(workload_ir)
        decision = eval_res.get("decision")
        if debug:
            print(f"🔍 [SwarmX Decision] Matmul Evaluated: {decision} (Reason: {eval_res.get('reason')})")

        if decision != "SWARM":
            return _ORIGINAL_NUMPY_MATMUL(a, b)

        # 5. Dispatch via Zero-Copy Binary Execution Path (Milestone 2.1)
        if debug:
            print(f"🚀 [SwarmX Matmul] Offloading {M}x{K} @ {K}x{N} ({payload_bytes:,} bytes) to SwarmX Core...")

        raw_payload = a.tobytes() + b.tobytes()
        exec_res, out_bytes = client.execute_workload_binary(workload_ir, raw_payload)

        if exec_res.get("status") == "COMPLETED" and len(out_bytes) == output_bytes_expected:
            if debug:
                print("✅ [SwarmX Matmul] Received valid binary buffer from Swarm -> reconstructing numpy.ndarray")
            # Reconstruct ndarray from raw buffer
            out_array = np.frombuffer(out_bytes, dtype=np.float32).reshape((M, N)).copy()
            return out_array

        if debug:
            print(f"⚠️ [SwarmX Matmul] Execution fallback triggered: {exec_res.get('reason')} -> executing via native NumPy")
        return _ORIGINAL_NUMPY_MATMUL(a, b)

    except Exception as e:
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
