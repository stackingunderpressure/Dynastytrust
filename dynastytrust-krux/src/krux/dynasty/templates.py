"""Template definitions + classifier for DynastyTrust taproot vaults.

A DynastyTrust vault is a taproot output of the shape::

    tr(NUMS, { leaf_1, leaf_2, ..., leaf_n })

where ``NUMS`` is the BIP 341 unspendable internal key and every ``leaf_i``
matches exactly one of five approved miniscript shapes. Any deviation --
wrong internal key, extra leaves, unrecognised leaf shape, duplicate roles
-- causes :func:`classify` to raise :class:`UnsupportedError` so the
signer fails closed.

The five shapes (all in taproot context, so ``thresh`` compiles to
``multi_a``):

    +-------------+----------------------------------------------------+
    | Normal      | ``multi_a(TrusteeQ, t1..tn)``                      |
    | Recovery    | ``and_v(v:after(R), multi_a(RQ, t1..tn))``         |
    | Inheritance | ``and_v(v:after(I), multi_a(HQ, h1..hn))``         |
    | Protector   | ``and_v(v:after(P), multi_a(PQ, p1..pn))``         |
    | Consent     | ``and_v(v:multi_a(TQ, t..), multi_a(CQ, c..))``    |
    +-------------+----------------------------------------------------+

1-key edge cases:

    Normal-1      ``pk(t1)``
    Recovery-1    ``and_v(v:after(R), pk(t1))``  (same for Inheritance,
                                                   Protector)
    Consent-1/1   ``and_v(v:pk(t), pk(c))``

These show up because the miniscript compiler prefers ``pk`` over
``multi_a(1,...)``. Both are accepted.

``canonicalize`` normalises argument ordering (sorted by key hex, leaves
sorted by serialized tapleaf) so that two descriptors that describe the
same policy with permuted inputs compare equal.

No network I/O, no embit tweak of keys here -- this module is pure AST
matching and string compares. It runs on the K210 without change.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional, Tuple

from embit.descriptor import Descriptor
from embit.descriptor.miniscript import Miniscript
from embit.descriptor.taptree import TapLeaf, TapTree


# BIP 341 standard NUMS point (x-only). This is the same constant the
# DynastyTrust compiler bakes into every vault as the internal key.
# Any descriptor whose internal key is not this is rejected.
NUMS_XONLY_HEX = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"


class UnsupportedError(ValueError):
    """Raised when a descriptor does not match any approved template.

    The message is user-facing: it's rendered on the signer screen so
    the operator knows *why* we refused. Keep it short and specific.
    """


class TemplateKind(Enum):
    NORMAL = "normal"
    RECOVERY = "recovery"
    INHERITANCE = "inheritance"
    PROTECTOR = "protector"
    CONSENT = "consent"


@dataclass
class LeafMatch:
    """One leaf, classified.

    For time-locked leaves ``absolute_locktime`` is the block height at
    which the leaf becomes spendable. ``keys`` is a list of 64-char
    hex-encoded x-only pubkeys, already sorted for stable comparison.
    Consent leaves carry a second key set in ``consent_keys``.
    """
    kind: TemplateKind
    quorum: int
    keys: List[str]
    absolute_locktime: Optional[int] = None
    consent_quorum: Optional[int] = None
    consent_keys: Optional[List[str]] = None

    def label(self) -> str:
        """Human-readable label for the signer's confirmation screen."""
        return {
            TemplateKind.NORMAL: "Normal trustee spend",
            TemplateKind.RECOVERY: "Recovery spend",
            TemplateKind.INHERITANCE: "Inheritance spend",
            TemplateKind.PROTECTOR: "Protector spend",
            TemplateKind.CONSENT: "Consent spend",
        }[self.kind]


@dataclass
class TemplateMatch:
    """Full descriptor classification.

    ``leaves`` is ordered by :class:`TemplateKind` declaration order --
    Normal first, Recovery, Inheritance, Protector, Consent. There is at
    most one leaf per kind in a well-formed vault; duplicates raise
    :class:`UnsupportedError`.
    """
    leaves: List[LeafMatch] = field(default_factory=list)

    def leaf(self, kind: TemplateKind) -> Optional[LeafMatch]:
        for leaf in self.leaves:
            if leaf.kind is kind:
                return leaf
        return None


# ---------------------------------------------------------------------------
# AST helpers
# ---------------------------------------------------------------------------


def _node_name(node) -> Optional[str]:
    """Miniscript node kind, e.g. ``multi_a``, ``and_v``, ``after``, ``pk``.

    Wrappers (``V``, ``C``, ``S``) have ``NAME=None``; we unwrap them
    transparently in :func:`_unwrap`.
    """
    return getattr(node, "NAME", None)


def _unwrap(node):
    """Peel single-argument wrappers off a miniscript node.

    Wrappers: ``V`` (VerifyScript), ``C``, ``S``, ``T``, ``N``, ``L``,
    ``J``, ``U``, ``A``, ``D``. Each has exactly one child in ``args``.
    We want to compare structural shape, not wrapper decoration.
    """
    wrapper_classes = {"V", "C", "S", "T", "N", "L", "J", "U", "A", "D"}
    while type(node).__name__ in wrapper_classes and len(node.args) == 1:
        node = node.args[0]
    return node


def _key_hex(node) -> str:
    """Extract the hex-encoded x-only pubkey from a ``Key`` miniscript node.

    embit's ``Key.key`` can be either a ``PublicKey`` object (when the
    underlying token parsed as a curve point) or a raw hex string. In
    the taproot context we want the 32-byte x-only form regardless.
    The ``Key`` node exposes an ``xonly`` attribute (bytes) that handles
    both input forms uniformly.
    """
    xonly = getattr(node, "xonly", None)
    # Key.xonly is a bytes property when the key is a concrete public key;
    # it can also be a bound method or None in edge cases. Handle both.
    if callable(xonly):
        try:
            xonly = xonly()
        except TypeError:
            xonly = None
    if isinstance(xonly, (bytes, bytearray)) and len(xonly) == 32:
        return bytes(xonly).hex().lower()
    # Fall back to ``.key`` which may itself be a PublicKey or a hex str.
    raw = node.key
    if hasattr(raw, "xonly"):
        try:
            raw_x = raw.xonly() if callable(raw.xonly) else raw.xonly
            if isinstance(raw_x, (bytes, bytearray)) and len(raw_x) == 32:
                return bytes(raw_x).hex().lower()
        except Exception:
            pass
    if hasattr(raw, "sec"):
        try:
            sec = raw.sec() if callable(raw.sec) else raw.sec
            if isinstance(sec, (bytes, bytearray)) and len(sec) == 33:
                return sec[1:].hex().lower()
        except Exception:
            pass
    if isinstance(raw, str):
        r = raw.lower()
        if len(r) == 66:  # compressed sec, strip parity
            r = r[2:]
        if len(r) == 64:
            return r
    raise UnsupportedError(f"cannot normalise key: {raw!r}")


def _is_pk(node) -> bool:
    return _node_name(node) == "pk"


def _is_multi_a(node) -> bool:
    return _node_name(node) == "multi_a"


def _is_after(node) -> bool:
    return _node_name(node) == "after"


def _is_and_v(node) -> bool:
    return _node_name(node) == "and_v"


# ---------------------------------------------------------------------------
# Leaf classification
# ---------------------------------------------------------------------------


def _keys_and_quorum(node) -> Tuple[int, List[str]]:
    """Pull (quorum, [key_hex,...]) out of either ``multi_a(Q,k1..kn)``
    or a bare ``pk(k)`` (which is the 1-of-1 canonical form).

    Keys are sorted lexicographically -- this is part of canonicalisation.
    """
    node = _unwrap(node)
    if _is_pk(node):
        return 1, [_key_hex(node.args[0])]
    if _is_multi_a(node):
        args = node.args
        if len(args) < 2:
            raise UnsupportedError("multi_a with no keys")
        threshold_node = args[0]
        if _node_name(threshold_node) is not None or not hasattr(threshold_node, "num"):
            raise UnsupportedError("multi_a threshold must be a literal")
        quorum = threshold_node.num
        keys = sorted(_key_hex(a) for a in args[1:])
        if quorum < 1 or quorum > len(keys):
            raise UnsupportedError(f"nonsensical quorum {quorum}/{len(keys)}")
        return quorum, keys
    raise UnsupportedError(f"expected multi_a or pk, got {_node_name(node)}")


def _after_height(node) -> int:
    node = _unwrap(node)
    if not _is_after(node):
        raise UnsupportedError(f"expected after(), got {_node_name(node)}")
    block = node.args[0].num
    if block <= 0:
        raise UnsupportedError(f"after() with non-positive height {block}")
    # BIP 65: lock times < 500,000,000 are block heights, >= are unix
    # timestamps. DynastyTrust uses block heights exclusively. Reject
    # anything that looks timestamp-shaped.
    if block >= 500_000_000:
        raise UnsupportedError("after() timestamp-shaped locktime not supported")
    return block


def _classify_leaf(leaf_mini: Miniscript) -> LeafMatch:
    """Turn one leaf's miniscript AST into a :class:`LeafMatch` or raise.

    Accepts the five shapes listed in the module docstring. Anything
    else raises :class:`UnsupportedError`. The kind decision is
    positional: Normal has no timelock + one key set; Consent has two
    key sets without timelock; Recovery/Inheritance/Protector all have
    timelock + one key set and are *structurally indistinguishable*
    here. :func:`classify` assigns those three based on the declared
    roles in the descriptor, not by looking at the leaf alone.
    """
    node = _unwrap(leaf_mini)

    # Normal shape: multi_a or pk directly.
    if _is_multi_a(node) or _is_pk(node):
        q, keys = _keys_and_quorum(node)
        return LeafMatch(kind=TemplateKind.NORMAL, quorum=q, keys=keys)

    # Timelocked or consent shape: and_v with two children.
    if _is_and_v(node) and len(node.args) == 2:
        lhs, rhs = _unwrap(node.args[0]), _unwrap(node.args[1])

        # Order-insensitive: and_v is conjunction; either child can be
        # the timelock. Check both orderings.
        if _is_after(lhs):
            return LeafMatch(
                kind=TemplateKind.RECOVERY,  # provisional; caller reclassifies
                quorum=_keys_and_quorum(rhs)[0],
                keys=_keys_and_quorum(rhs)[1],
                absolute_locktime=_after_height(lhs),
            )
        if _is_after(rhs):
            return LeafMatch(
                kind=TemplateKind.RECOVERY,
                quorum=_keys_and_quorum(lhs)[0],
                keys=_keys_and_quorum(lhs)[1],
                absolute_locktime=_after_height(rhs),
            )

        # Consent: both children are key-only quorums.
        if (_is_multi_a(lhs) or _is_pk(lhs)) and (_is_multi_a(rhs) or _is_pk(rhs)):
            tq, tkeys = _keys_and_quorum(lhs)
            cq, ckeys = _keys_and_quorum(rhs)
            # Canonicalise the pairing by the lexicographically smaller
            # first key of each side so consent leaves compare stably
            # regardless of compiler ordering.
            if ckeys[0] < tkeys[0]:
                tq, cq = cq, tq
                tkeys, ckeys = ckeys, tkeys
            return LeafMatch(
                kind=TemplateKind.CONSENT,
                quorum=tq,
                keys=tkeys,
                consent_quorum=cq,
                consent_keys=ckeys,
            )

    raise UnsupportedError(f"unrecognised leaf shape: {leaf_mini}")


# ---------------------------------------------------------------------------
# Taptree walk
# ---------------------------------------------------------------------------


def _iter_leaves(taptree: TapTree) -> List[TapLeaf]:
    """Flatten a TapTree into a list of TapLeaf nodes.

    Embit represents the tree with ``TapTree.tree`` being either a tuple
    of two child TapTrees (branch) or a :class:`TapLeaf` (terminal).
    """
    out: List[TapLeaf] = []

    def walk(node: TapTree) -> None:
        child = node.tree
        if isinstance(child, tuple):
            for c in child:
                walk(c)
        elif isinstance(child, TapLeaf):
            out.append(child)
        else:
            raise UnsupportedError(
                f"unexpected taptree node type {type(child).__name__}"
            )

    walk(taptree)
    return out


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def canonicalize(leaves: List[LeafMatch]) -> Tuple:
    """Stable structural key for comparing template matches.

    Two :class:`TemplateMatch` results for the same policy compare equal
    under ``canonicalize(m.leaves) == canonicalize(m2.leaves)`` regardless
    of leaf-ordering in the descriptor or key-ordering inside each
    ``multi_a``. Useful in tests and in future permission caching.
    """
    def leaf_key(leaf: LeafMatch) -> Tuple:
        return (
            leaf.kind.value,
            leaf.quorum,
            tuple(leaf.keys),
            leaf.absolute_locktime,
            leaf.consent_quorum,
            tuple(leaf.consent_keys) if leaf.consent_keys else None,
        )
    return tuple(sorted((leaf_key(l) for l in leaves)))


def classify(descriptor: Descriptor) -> TemplateMatch:
    """Classify a DynastyTrust taproot descriptor or raise.

    The descriptor must be ``tr(NUMS, { ... })`` with every leaf matching
    one of the five approved shapes. Timelocked leaves (Recovery,
    Inheritance, Protector) are disambiguated by their locktime value:

        smallest -> Recovery
        middle   -> Inheritance
        largest  -> Protector

    This matches the DynastyTrust compiler's convention where recovery
    < inheritance < protector. If fewer than three timelocks exist we
    take them in order, first -> Recovery. A vault with only a Normal
    leaf is accepted (the degenerate 1-leaf case).

    Duplicate roles (two Recovery leaves, two Consent leaves, etc.)
    raise :class:`UnsupportedError`.
    """
    # 1. Internal key must be NUMS.
    internal = descriptor.key
    if internal is None:
        raise UnsupportedError("descriptor has no internal key")
    internal_hex = _key_hex(internal)
    if internal_hex != NUMS_XONLY_HEX:
        raise UnsupportedError(
            "internal key must be BIP 341 NUMS; got " + internal_hex[:16] + "..."
        )

    # 2. Must have a taptree. embit represents a missing taptree as an
    #    empty TapTree whose ``.tree`` is ``None``; detect both forms.
    taptree = descriptor.taptree
    if taptree is None or getattr(taptree, "tree", None) is None:
        raise UnsupportedError("tr() has no script tree; key-path-only not allowed")

    # 3. Walk and classify each leaf.
    raw_leaves = _iter_leaves(taptree)
    if not raw_leaves:
        raise UnsupportedError("empty taptree")
    if len(raw_leaves) > 5:
        raise UnsupportedError(f"too many leaves ({len(raw_leaves)}); max 5")

    classified: List[LeafMatch] = [
        _classify_leaf(tl.miniscript) for tl in raw_leaves
    ]

    # 4. Disambiguate the three provisional RECOVERY leaves by locktime
    #    order. Sort timelocked-leaves by locktime ascending and assign
    #    RECOVERY -> INHERITANCE -> PROTECTOR.
    timelocked = [l for l in classified if l.absolute_locktime is not None]
    other = [l for l in classified if l.absolute_locktime is None]
    timelocked.sort(key=lambda l: l.absolute_locktime)  # type: ignore[arg-type]

    role_order = [TemplateKind.RECOVERY, TemplateKind.INHERITANCE, TemplateKind.PROTECTOR]
    if len(timelocked) > len(role_order):
        raise UnsupportedError(
            f"too many timelocked leaves ({len(timelocked)}); max 3"
        )
    for leaf, role in zip(timelocked, role_order):
        leaf.kind = role

    # 5. Normal and Consent can each appear at most once. Timelocked
    #    roles are unique by construction (we assigned them distinct
    #    kinds).
    normal_count = sum(1 for l in other if l.kind is TemplateKind.NORMAL)
    consent_count = sum(1 for l in other if l.kind is TemplateKind.CONSENT)
    if normal_count > 1:
        raise UnsupportedError("duplicate Normal leaf")
    if consent_count > 1:
        raise UnsupportedError("duplicate Consent leaf")

    # 6. Return in declaration order for UI predictability.
    match = TemplateMatch()
    kind_order = [
        TemplateKind.NORMAL,
        TemplateKind.RECOVERY,
        TemplateKind.INHERITANCE,
        TemplateKind.PROTECTOR,
        TemplateKind.CONSENT,
    ]
    for kind in kind_order:
        for leaf in classified:
            if leaf.kind is kind:
                match.leaves.append(leaf)
                break
    return match
