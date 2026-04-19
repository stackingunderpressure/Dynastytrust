"""DynastyTrust trust-mode extension for Krux.

Phase 1 exports: the template matcher. Later phases add a policy guard
(``policy_guard``), persistent allowlist storage (``allowlist``), and UI
screens (``ui``). None of those are imported here -- keeps the dependency
footprint small on K210 hardware, where Krux lazy-imports features.
"""

from .templates import (
    NUMS_XONLY_HEX,
    TemplateKind,
    TemplateMatch,
    LeafMatch,
    canonicalize,
    classify,
    UnsupportedError,
)

__all__ = [
    "NUMS_XONLY_HEX",
    "TemplateKind",
    "TemplateMatch",
    "LeafMatch",
    "canonicalize",
    "classify",
    "UnsupportedError",
]
