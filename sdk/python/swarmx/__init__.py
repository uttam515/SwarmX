from .decorator import parallel, swarm
from .chunking import AdaptiveChunker
from .client import SwarmClient
from .interceptor import install_interceptor, uninstall_interceptor

__all__ = [
    "parallel",
    "swarm",
    "AdaptiveChunker",
    "SwarmClient",
    "install_interceptor",
    "uninstall_interceptor"
]
__version__ = "0.1.0"

