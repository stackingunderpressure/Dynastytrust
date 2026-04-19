"""Template classifier tests.

Happy path: every approved shape parses to the right :class:`TemplateMatch`
with accurate quorums, keys, and locktimes.

Negative path: everything else raises :class:`UnsupportedError`. These are
what protect the device -- a missed rejection is a security bug.
"""
from __future__ import annotations

import pytest
from embit.descriptor import Descriptor

from krux.dynasty import (
    NUMS_XONLY_HEX,
    TemplateKind,
    UnsupportedError,
    canonicalize,
    classify,
)
from tests.conftest import (
    NUMS_HEX,
    consent_leaf,
    make_descriptor,
    normal_leaf,
    timelock_leaf,
)


# ---------------------------------------------------------------------------
# Happy path -- every approved shape
# ---------------------------------------------------------------------------


def test_normal_only_multi(t_keys):
    """Single-leaf vault: 2-of-3 trustees, no timelocks, no consent."""
    d_str = make_descriptor([normal_leaf(t_keys, 2)])
    d = Descriptor.from_string(d_str)
    m = classify(d)
    assert len(m.leaves) == 1
    leaf = m.leaves[0]
    assert leaf.kind is TemplateKind.NORMAL
    assert leaf.quorum == 2
    assert leaf.keys == t_keys
    assert leaf.absolute_locktime is None
    assert leaf.label() == "Normal trustee spend"


def test_normal_single_key_via_pk():
    """1-of-1 collapses to pk(K); must still classify as Normal."""
    key = "0" * 63 + "1"
    d = Descriptor.from_string(make_descriptor([normal_leaf([key], 1)]))
    m = classify(d)
    assert m.leaves[0].kind is TemplateKind.NORMAL
    assert m.leaves[0].quorum == 1
    assert m.leaves[0].keys == [key]


def test_recovery(t_keys):
    """Normal + Recovery with a 26000-block timelock (the DynastyTrust floor)."""
    leaves = [
        normal_leaf(t_keys, 2),
        timelock_leaf(t_keys, 1, 26_000),
    ]
    d = Descriptor.from_string(make_descriptor(leaves))
    m = classify(d)
    assert [l.kind for l in m.leaves] == [TemplateKind.NORMAL, TemplateKind.RECOVERY]
    recovery = m.leaf(TemplateKind.RECOVERY)
    assert recovery.quorum == 1
    assert recovery.keys == t_keys
    assert recovery.absolute_locktime == 26_000


def test_recovery_inheritance_protector(t_keys, h_keys, p_keys):
    """Full four-leaf vault: Normal + Recovery + Inheritance + Protector."""
    leaves = [
        normal_leaf(t_keys, 2),
        timelock_leaf(t_keys, 1, 26_000),          # Recovery
        timelock_leaf(h_keys, 2, 100_000),         # Inheritance
        timelock_leaf(p_keys, 1, 500_000),         # Protector
    ]
    d = Descriptor.from_string(make_descriptor(leaves))
    m = classify(d)
    assert [l.kind for l in m.leaves] == [
        TemplateKind.NORMAL,
        TemplateKind.RECOVERY,
        TemplateKind.INHERITANCE,
        TemplateKind.PROTECTOR,
    ]
    assert m.leaf(TemplateKind.RECOVERY).absolute_locktime == 26_000
    assert m.leaf(TemplateKind.INHERITANCE).absolute_locktime == 100_000
    assert m.leaf(TemplateKind.PROTECTOR).absolute_locktime == 500_000
    assert m.leaf(TemplateKind.INHERITANCE).keys == h_keys
    assert m.leaf(TemplateKind.PROTECTOR).keys == p_keys


def test_consent(t_keys, c_keys):
    """Consent: trustees + beneficiaries both sign, no timelock."""
    leaves = [
        normal_leaf(t_keys, 2),
        consent_leaf(t_keys, 2, c_keys, 1),
    ]
    d = Descriptor.from_string(make_descriptor(leaves))
    m = classify(d)
    assert [l.kind for l in m.leaves] == [TemplateKind.NORMAL, TemplateKind.CONSENT]
    consent = m.leaf(TemplateKind.CONSENT)
    assert consent.quorum == 2
    assert consent.keys == t_keys
    assert consent.consent_quorum == 1
    assert consent.consent_keys == c_keys


def test_normal_missing_is_ok(t_keys, h_keys):
    """Recovery-only vault (no Normal leaf) is accepted. Edge case for
    legacy-style inheritance-only wallets."""
    leaves = [
        timelock_leaf(t_keys, 1, 26_000),
        timelock_leaf(h_keys, 2, 100_000),
    ]
    d = Descriptor.from_string(make_descriptor(leaves))
    m = classify(d)
    assert [l.kind for l in m.leaves] == [TemplateKind.RECOVERY, TemplateKind.INHERITANCE]


# ---------------------------------------------------------------------------
# Canonicalisation
# ---------------------------------------------------------------------------


def test_canonicalize_order_insensitive(t_keys, h_keys):
    """Same policy expressed with leaves in different string orders should
    canonicalise to the same tuple."""
    leaves_a = [
        normal_leaf(t_keys, 2),
        timelock_leaf(t_keys, 1, 26_000),
        timelock_leaf(h_keys, 2, 100_000),
    ]
    leaves_b = [
        timelock_leaf(h_keys, 2, 100_000),
        normal_leaf(t_keys, 2),
        timelock_leaf(t_keys, 1, 26_000),
    ]
    m_a = classify(Descriptor.from_string(make_descriptor(leaves_a)))
    m_b = classify(Descriptor.from_string(make_descriptor(leaves_b)))
    assert canonicalize(m_a.leaves) == canonicalize(m_b.leaves)


def test_canonicalize_key_order_insensitive(t_keys):
    """multi_a with keys in a different order is the same policy."""
    reversed_keys = list(reversed(t_keys))
    leaves_a = [normal_leaf(t_keys, 2)]
    leaves_b = [normal_leaf(reversed_keys, 2)]
    m_a = classify(Descriptor.from_string(make_descriptor(leaves_a)))
    m_b = classify(Descriptor.from_string(make_descriptor(leaves_b)))
    assert canonicalize(m_a.leaves) == canonicalize(m_b.leaves)


# ---------------------------------------------------------------------------
# Rejection path -- anything not in the allowlist must raise
# ---------------------------------------------------------------------------


def test_rejects_non_nums_internal_key(t_keys):
    """Internal key != NUMS is rejected even if leaves look valid."""
    bogus_internal = "a" * 64
    d_str = f"tr({bogus_internal},{{{normal_leaf(t_keys, 2)}}})"
    d = Descriptor.from_string(d_str)
    with pytest.raises(UnsupportedError, match="NUMS"):
        classify(d)


def test_rejects_keypath_only():
    """tr(NUMS) with no taptree would be pure key-path, which NUMS
    forbids cryptographically but we also reject at the parser level."""
    d = Descriptor.from_string(f"tr({NUMS_HEX})")
    with pytest.raises(UnsupportedError, match="key-path"):
        classify(d)


def test_rejects_too_many_leaves(t_keys):
    """Six leaves exceed the maximum of 5 allowed templates."""
    leaves = [
        normal_leaf(t_keys, 2),
        timelock_leaf(t_keys, 1, 26_000),
        timelock_leaf(t_keys, 1, 100_000),
        timelock_leaf(t_keys, 1, 200_000),
        timelock_leaf(t_keys, 1, 300_000),
        timelock_leaf(t_keys, 1, 400_000),
    ]
    d = Descriptor.from_string(make_descriptor(leaves))
    with pytest.raises(UnsupportedError, match="too many"):
        classify(d)


def test_rejects_unknown_leaf_shape(t_keys):
    """older() (relative CSV) instead of after() (absolute CLTV) is
    outside the spec -- DynastyTrust uses only absolute timelocks."""
    bogus = f"and_v(v:older(26000),{normal_leaf(t_keys, 2)})"
    leaves = [normal_leaf(t_keys, 2), bogus]
    d = Descriptor.from_string(make_descriptor(leaves))
    with pytest.raises(UnsupportedError):
        classify(d)


def test_rejects_timestamp_locktime(t_keys):
    """after() with a value >= 500,000,000 would be interpreted as a
    unix timestamp, not a block height. DynastyTrust uses block
    heights exclusively -- reject."""
    leaves = [
        normal_leaf(t_keys, 2),
        timelock_leaf(t_keys, 1, 1_700_000_000),  # a real 2023-ish timestamp
    ]
    d = Descriptor.from_string(make_descriptor(leaves))
    with pytest.raises(UnsupportedError, match="timestamp"):
        classify(d)


def test_rejects_too_many_timelocks(t_keys, h_keys, p_keys):
    """Four distinct timelocked leaves exceed the Recovery/Inheritance/
    Protector triple. The fifth slot is Consent, not a timelock."""
    leaves = [
        timelock_leaf(t_keys, 1, 26_000),
        timelock_leaf(t_keys, 1, 50_000),
        timelock_leaf(h_keys, 2, 100_000),
        timelock_leaf(p_keys, 1, 500_000),
    ]
    d = Descriptor.from_string(make_descriptor(leaves))
    with pytest.raises(UnsupportedError, match="too many timelocked"):
        classify(d)


def test_rejects_duplicate_normal(t_keys):
    """Two Normal leaves are ambiguous and we refuse them."""
    leaves = [
        normal_leaf(t_keys, 2),
        normal_leaf(t_keys, 1),
    ]
    d = Descriptor.from_string(make_descriptor(leaves))
    with pytest.raises(UnsupportedError, match="duplicate Normal"):
        classify(d)


def test_rejects_nonsense_quorum(t_keys):
    """Quorum-exceeds-key-count would be rejected by our classifier
    independently of whatever embit does at parse time. Construct the
    AST directly so we exercise our guard rather than embit's.

    The classifier's _keys_and_quorum() raises when quorum > len(keys).
    This is a defensive layer: embit currently validates this upstream,
    but we shouldn't rely on it.
    """
    from krux.dynasty.templates import _keys_and_quorum, UnsupportedError as UE

    class FakeNumber:
        num = 4
    class FakeKey:
        key = t_keys[0]
        xonly = bytes.fromhex(t_keys[0])
    class FakeMultiA:
        NAME = "multi_a"
        # 4-of-3 is nonsense
        args = (FakeNumber(), FakeKey(), FakeKey(), FakeKey())

    with pytest.raises(UE, match="nonsensical quorum"):
        _keys_and_quorum(FakeMultiA())
