"""DynastyTrust trust-mode extension for Krux.

Phase 1 exports the template matcher; Phase 2 adds the policy guard;
Phase 2.5 adds the descriptor hash + persistent allowlist storage;
Phase 3 adds the PSBT adapter, timelock formatter, and on-device UI
screens. Imports are kept shallow so K210 lazy-loaders only pay for
what's actually used.
"""

from .templates import (
    NUMS_XONLY_HEX,
    TemplateKind,
    TemplateMatch,
    LeafMatch,
    canonicalize,
    classify,
    classify_with_scripts,
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
from .psbt_adapter import adapt
from .timelock import (
    BLOCKS_PER_DAY,
    BLOCKS_PER_HOUR,
    BLOCKS_PER_MONTH,
    BLOCKS_PER_WEEK,
    BLOCKS_PER_YEAR,
    blocks_to_label,
    format_unlock,
)

__all__ = [
    # templates
    "NUMS_XONLY_HEX",
    "TemplateKind",
    "TemplateMatch",
    "LeafMatch",
    "canonicalize",
    "classify",
    "classify_with_scripts",
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
    # psbt_adapter
    "adapt",
    # timelock
    "BLOCKS_PER_DAY",
    "BLOCKS_PER_HOUR",
    "BLOCKS_PER_MONTH",
    "BLOCKS_PER_WEEK",
    "BLOCKS_PER_YEAR",
    "blocks_to_label",
    "format_unlock",
]
