"""DynastyTrust trust-mode extension for Krux.

Phase 1 exports the template matcher; Phase 2 adds the policy guard.
Phase 3 will add allowlist persistence + UI. Imports are kept shallow
so K210 lazy-loaders only pay for what's actually used.
"""

from .templates import (
    NUMS_XONLY_HEX,
    TemplateKind,
    TemplateMatch,
    LeafMatch,
    canonicalize,
    classify,
    descriptor_hash,
    UnsupportedError,
)
from .policy_guard import (
    GuardInput,
    GuardOutput,
    GuardCheckResult,
    check,
    leaf_script_index,
    ACCEPTABLE_SIGHASH,
    SEQUENCE_FINAL,
)
from .allowlist import (
    APPROVED_ROLES,
    Allowlist,
    Provisioning,
    ProvisioningError,
    SCHEMA_VERSION,
    load,
    save,
)

__all__ = [
    # templates
    "NUMS_XONLY_HEX",
    "TemplateKind",
    "TemplateMatch",
    "LeafMatch",
    "canonicalize",
    "classify",
    "descriptor_hash",
    "UnsupportedError",
    # policy_guard
    "GuardInput",
    "GuardOutput",
    "GuardCheckResult",
    "check",
    "leaf_script_index",
    "ACCEPTABLE_SIGHASH",
    "SEQUENCE_FINAL",
    # allowlist
    "APPROVED_ROLES",
    "Allowlist",
    "Provisioning",
    "ProvisioningError",
    "SCHEMA_VERSION",
    "load",
    "save",
]
