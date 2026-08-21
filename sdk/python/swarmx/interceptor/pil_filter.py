import base64
import os
import threading
import uuid
from typing import Optional
from PIL import Image, ImageFilter
from swarmx.client import SwarmClient

# Preserve reference to the original C-extension implementation
_ORIGINAL_PIL_FILTER = Image.Image.filter
_INTERCEPTOR_INSTALLED = False
_GLOBAL_CLIENT: Optional[SwarmClient] = None
_WORKLOAD_COUNTER = 0
_COUNTER_LOCK = threading.Lock()

def _next_workload_id(kernel_name: str = "boxblur") -> str:
    global _WORKLOAD_COUNTER
    with _COUNTER_LOCK:
        _WORKLOAD_COUNTER += 1
        count = _WORKLOAD_COUNTER
    prefix = os.environ.get("SWARMX_WORKLOAD_PREFIX", "wkl")
    return f"{prefix}-{kernel_name}-demo-{count:03d}"

def get_swarm_client(socket_path: str = "/tmp/swarmx.sock") -> SwarmClient:
    from swarmx.client import get_thread_local_client
    env_sock = os.environ.get("SWARMX_IPC_PATH", socket_path)
    return get_thread_local_client(socket_path=env_sock, timeout=30.0)

def is_certified_box_blur(filter_spec) -> bool:
    """Only certified ImageFilter.BoxBlur operations with a valid radius are eligible."""
    if isinstance(filter_spec, ImageFilter.BoxBlur):
        return hasattr(filter_spec, 'radius') and filter_spec.radius is not None
    return False

def swarmx_image_filter(self: Image.Image, filter_spec) -> Image.Image:
    """
    Transparent SwarmX Interceptor for PIL.Image.Image.filter.
    Intercepts only certified ImageFilter.BoxBlur operations.
    Fails closed to _ORIGINAL_PIL_FILTER on any error, uncertified filter, or Core unavailability.
    """
    # 1. Strict Gating: If not certified BoxBlur -> Immediate local PIL bypass
    if not is_certified_box_blur(filter_spec):
        return _ORIGINAL_PIL_FILTER(self, filter_spec)

    # 2. Extract image metadata
    try:
        width, height = self.size
        mode = self.mode
        radius = getattr(filter_spec, 'radius', 2)

        # Planar byte payload
        raw_bytes = self.tobytes()
        payload_bytes = len(raw_bytes)

        # 3. Check Core socket connectivity
        debug = os.environ.get("SWARMX_DEBUG") == "1"
        if debug:
            print(f"🐝 [SwarmX Interceptor] Intercepted certified BoxBlur: {width}x{height} {mode} ({payload_bytes} bytes, radius={radius})")

        client = get_swarm_client()
        if not client.is_connected():
            if not client.connect():
                if debug:
                    print("⚠️ [SwarmX Interceptor] Core socket offline -> executing via original PIL")
                return _ORIGINAL_PIL_FILTER(self, filter_spec)

        # 4. Construct platform-neutral Workload IR (metadata only for evaluation)
        workload_ir = {
            "workloadId": _next_workload_id("boxblur"),
            "version": "1.0.0",
            "computation": {
                "domain": "IMAGE_PROCESSING",
                "kernelId": "image_filter_box_blur_v1",
                "parameters": {
                    "radius": radius,
                    "width": width,
                    "height": height,
                    "mode": mode
                }
            },
            "data": {
                "itemCount": 1,
                "totalPayloadBytes": payload_bytes,
                "format": f"RAW_PLANAR_{mode}_UINT8"
            },
            "constraints": {
                "isPure": True,
                "isIdempotent": True,
                "toleranceValidator": "IMAGE_PIXEL_DELTA",
                "maxDelta": 2,
                "maxMse": 0.5
            }
        }

        force_swarm = os.environ.get("SWARMX_FORCE_SWARM") == "1"

        # 5. Evaluate Workload with Core Decision Engine
        eval_res = client.evaluate_workload(workload_ir)
        decision = eval_res.get("decision")
        if debug:
            print(f"🔍 [SwarmX Decision] Evaluated: {decision} (Reason: {eval_res.get('reason')})")

        if decision != "SWARM" and not force_swarm:
            # Local decision -> execute original PIL in-process
            return _ORIGINAL_PIL_FILTER(self, filter_spec)

        # 6. SWARM / FORCED SWARM Decision: Dispatch through Zero-Copy Binary Execution Path (Milestone 2.1)
        if debug:
            print("🚀 [SwarmX Execution] Dispatching zero-copy binary workload to SwarmX Core...")

        exec_res, output_bytes = client.execute_workload_binary(workload_ir, raw_bytes, force_swarm=force_swarm)
        if exec_res.get("status") == "COMPLETED" and len(output_bytes) == payload_bytes:
            if debug:
                print("✅ [SwarmX Execution] Received valid binary buffer from Swarm -> reconstructing PIL.Image.Image")
            return Image.frombytes(mode, (width, height), output_bytes)

        if force_swarm:
            # In forced demo mode, fail clearly if remote execution fails rather than silently falling back
            raise RuntimeError(f"ERROR: Forced Swarm execution failed: {exec_res.get('reason', 'Remote worker execution error')}")

        # Execution returned fallback or validation failure -> fail closed
        if debug:
            print(f"⚠️ [SwarmX Execution] Fallback triggered: {exec_res.get('reason')} -> executing original PIL")
        return _ORIGINAL_PIL_FILTER(self, filter_spec)

    except Exception as e:
        if force_swarm:
            raise
        if os.environ.get("SWARMX_DEBUG") == "1":
            print(f"⚠️ [SwarmX Error] Exception during interception: {e} -> falling back to original PIL")
        return _ORIGINAL_PIL_FILTER(self, filter_spec)

def install_interceptor():
    """Installs the transparent PIL Image.filter interceptor."""
    global _INTERCEPTOR_INSTALLED
    if not _INTERCEPTOR_INSTALLED:
        Image.Image.filter = swarmx_image_filter
        _INTERCEPTOR_INSTALLED = True

def uninstall_interceptor():
    """Uninstalls the interceptor and restores vanilla PIL behavior."""
    global _INTERCEPTOR_INSTALLED
    if _INTERCEPTOR_INSTALLED:
        Image.Image.filter = _ORIGINAL_PIL_FILTER
        _INTERCEPTOR_INSTALLED = False
