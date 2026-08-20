from .pil_filter import install_interceptor as install_pil_interceptor, uninstall_interceptor as uninstall_pil_interceptor, is_certified_box_blur
from .numpy_matmul import install_interceptor as install_numpy_interceptor, uninstall_interceptor as uninstall_numpy_interceptor, is_certified_matmul

def install_interceptor():
    install_pil_interceptor()
    install_numpy_interceptor()

def uninstall_interceptor():
    uninstall_pil_interceptor()
    uninstall_numpy_interceptor()

__all__ = [
    "install_interceptor",
    "uninstall_interceptor",
    "install_pil_interceptor",
    "uninstall_pil_interceptor",
    "install_numpy_interceptor",
    "uninstall_numpy_interceptor",
    "is_certified_box_blur",
    "is_certified_matmul"
]

