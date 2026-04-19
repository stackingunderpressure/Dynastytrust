"""Policy guard tests.

Phase 2 keeps the guard signature-shape-agnostic: tests build
:class:`GuardInput` / :class:`GuardOutput` dataclasses directly rather
than constructing real PSBT bytes. Phase 3 wires a thin embit-PSBT-to-
dataclass adapter; the guard logic itself is exercised exhaustively
here without that adapter.

Each happy-path test produces a single positive verdict for one of the
five branches. Each rejection-path test feeds a deliberately broken
input and asserts both ``ok=False`` and a specific ``reason`` substring.
"""
from __future__ import annotations

import pytest

from krux.dynasty import (
    GuardCheckResult,
    GuardInput,
    GuardOutput,
    LeafMatch,
    SEQUENCE_FINAL,
    TemplateKind,
    TemplateMatch,
    check,
    leaf_script_index,
)


# ---------------------------------------------------------------------------
# Fixture helpers -- build the world the guard sees
# ---------------------------------------------------------------------------

# Vault's own scriptPubKey hex. The guard treats it as opaque -- only the
# string equality matters.
VAULT_SPK = "5120" + "11" * 32  # OP_1 + 32-byte taproot output (fake bytes)
EXTERNAL_SPK = "0014" + "22" * 20  # P2WPKH-shaped external destination


def _normal_template():
    """Single-leaf Normal template with arbitrary key + script bytes."""
    leaf = LeafMatch(
        kind=TemplateKind.NORMAL,
        quorum=2,
        keys=["a" * 64, "b" * 64, "c" * 64],
    )
    return TemplateMatch(leaves=[leaf]), {"deadbeef": leaf}


def _full_template(recovery_block=26_000, inheritance_block=100_000):
    """Normal + Recovery + Inheritance + Protector + Consent. Each leaf
    gets a unique fake script hex so the guard can disambiguate them."""
    n = LeafMatch(kind=TemplateKind.NORMAL, quorum=2, keys=["a" * 64])
    r = LeafMatch(
        kind=TemplateKind.RECOVERY,
        quorum=1,
        keys=["a" * 64],
        absolute_locktime=recovery_block,
    )
    i = LeafMatch(
        kind=TemplateKind.INHERITANCE,
        quorum=2,
        keys=["d" * 64, "e" * 64],
        absolute_locktime=inheritance_block,
    )
    p = LeafMatch(
        kind=TemplateKind.PROTECTOR,
        quorum=1,
        keys=["f" * 64],
        absolute_locktime=500_000,
    )
    c = LeafMatch(
        kind=TemplateKind.CONSENT,
        quorum=2,
        keys=["a" * 64],
        consent_quorum=1,
        consent_keys=["c" * 64, "d" * 64],
    )
    template = TemplateMatch(leaves=[n, r, i, p, c])
    leaf_to_match = {
        "1111": n,
        "2222": r,
        "3333": i,
        "4444": p,
        "5555": c,
    }
    return template, leaf_to_match


def _inp(leaf_hex, value=100_000, sequence=0xFFFFFFFE, sighash=0x00,
         spk=None):
    return GuardInput(
        sequence=sequence,
        sighash_type=sighash,
        leaf_script_hex=leaf_hex,
        utxo_script_pubkey_hex=spk or VAULT_SPK,
        value_sats=value,
    )


def _out(value, is_change=False, spk=None):
    return GuardOutput(
        script_pubkey_hex=spk or EXTERNAL_SPK,
        value_sats=value,
        is_change=is_change,
    )


# ---------------------------------------------------------------------------
# Happy path -- one assertion per branch
# ---------------------------------------------------------------------------


def test_normal_branch_clean_spend():
    template, idx = _normal_template()
    inputs = [_inp("deadbeef", value=100_000)]
    outputs = [_out(80_000), _out(19_000, is_change=True)]
    res = check(
        template=template,
        inputs=inputs,
        outputs=outputs,
        tx_lock_time=0,
        leaf_to_match=idx,
        expected_input_script_hex=VAULT_SPK,
    )
    assert res.ok, res.reason
    assert res.branch is TemplateKind.NORMAL
    assert res.fee_sats == 1_000
    assert res.change_sats == 19_000
    assert res.destination_sats == 80_000
    assert res.warnings == []


def test_recovery_branch_at_lock_time():
    template, idx = _full_template(recovery_block=26_000)
    res = check(
        template=template,
        inputs=[_inp("2222")],
        outputs=[_out(80_000), _out(19_000, is_change=True)],
        tx_lock_time=26_000,
        leaf_to_match=idx,
        expected_input_script_hex=VAULT_SPK,
    )
    assert res.ok, res.reason
    assert res.branch is TemplateKind.RECOVERY


def test_inheritance_branch_above_lock_time():
    """Sufficient lock_time = pass; doesn't have to equal exactly."""
    template, idx = _full_template(inheritance_block=100_000)
    res = check(
        template=template,
        inputs=[_inp("3333")],
        outputs=[_out(99_000)],
        tx_lock_time=100_500,
        leaf_to_match=idx,
        expected_input_script_hex=VAULT_SPK,
    )
    assert res.ok, res.reason
    assert res.branch is TemplateKind.INHERITANCE


def test_protector_branch():
    template, idx = _full_template()
    res = check(
        template=template,
        inputs=[_inp("4444")],
        outputs=[_out(99_000)],
        tx_lock_time=500_000,
        leaf_to_match=idx,
        expected_input_script_hex=VAULT_SPK,
    )
    assert res.ok, res.reason
    assert res.branch is TemplateKind.PROTECTOR


def test_consent_branch():
    template, idx = _full_template()
    res = check(
        template=template,
        inputs=[_inp("5555")],
        outputs=[_out(99_000)],
        tx_lock_time=0,
        leaf_to_match=idx,
        expected_input_script_hex=VAULT_SPK,
    )
    assert res.ok, res.reason
    assert res.branch is TemplateKind.CONSENT


def test_high_fee_warns_but_passes():
    """Fee above the warn threshold is non-fatal; user sees the caution."""
    template, idx = _normal_template()
    inputs = [_inp("deadbeef", value=100_000)]
    outputs = [_out(50_000)]
    res = check(
        template=template,
        inputs=inputs,
        outputs=outputs,
        tx_lock_time=0,
        leaf_to_match=idx,
        expected_input_script_hex=VAULT_SPK,
        high_fee_warn_pct=5.0,
    )
    assert res.ok
    assert res.fee_sats == 50_000
    assert any("High fee" in w for w in res.warnings)


# ---------------------------------------------------------------------------
# Rejection path -- adversarial corpus
# ---------------------------------------------------------------------------


def test_rejects_no_inputs():
    template, idx = _normal_template()
    res = check(template, [], [_out(1)], 0, idx, VAULT_SPK)
    assert not res.ok and "No inputs" in res.reason


def test_rejects_no_outputs():
    template, idx = _normal_template()
    res = check(template, [_inp("deadbeef")], [], 0, idx, VAULT_SPK)
    assert not res.ok and "No outputs" in res.reason


def test_rejects_unknown_leaf():
    template, idx = _normal_template()
    res = check(
        template=template,
        inputs=[_inp("ffff")],  # not in idx
        outputs=[_out(1)],
        tx_lock_time=0,
        leaf_to_match=idx,
        expected_input_script_hex=VAULT_SPK,
    )
    assert not res.ok and "not in approved templates" in res.reason


def test_rejects_missing_leaf_script():
    template, idx = _normal_template()
    res = check(
        template=template,
        inputs=[_inp(None)],
        outputs=[_out(1)],
        tx_lock_time=0,
        leaf_to_match=idx,
        expected_input_script_hex=VAULT_SPK,
    )
    assert not res.ok and "does not specify which leaf" in res.reason


def test_rejects_mixed_branches():
    """Two inputs spending through different leaves is rejected -- the
    coordinator has to keep one transaction one branch."""
    template, idx = _full_template()
    res = check(
        template=template,
        inputs=[_inp("1111"), _inp("2222")],
        outputs=[_out(1)],
        tx_lock_time=26_000,  # would satisfy 2222 but not 1111
        leaf_to_match=idx,
        expected_input_script_hex=VAULT_SPK,
    )
    assert not res.ok and "different leaves" in res.reason


def test_rejects_recovery_lock_time_too_small():
    template, idx = _full_template(recovery_block=26_000)
    res = check(
        template=template,
        inputs=[_inp("2222")],
        outputs=[_out(99_000)],
        tx_lock_time=25_999,  # one block short
        leaf_to_match=idx,
        expected_input_script_hex=VAULT_SPK,
    )
    assert not res.ok and "below leaf requirement" in res.reason


def test_rejects_normal_with_nonzero_lock_time():
    """A Normal spend with a lock_time set is suspicious; reject."""
    template, idx = _normal_template()
    res = check(
        template=template,
        inputs=[_inp("deadbeef")],
        outputs=[_out(99_000)],
        tx_lock_time=42,
        leaf_to_match=idx,
        expected_input_script_hex=VAULT_SPK,
    )
    assert not res.ok and "expected 0" in res.reason


def test_rejects_timelocked_with_final_sequence():
    """CLTV requires nSequence < 0xFFFFFFFF on at least one input;
    trust mode requires it on all inputs."""
    template, idx = _full_template(recovery_block=26_000)
    res = check(
        template=template,
        inputs=[_inp("2222", sequence=SEQUENCE_FINAL)],
        outputs=[_out(99_000)],
        tx_lock_time=26_000,
        leaf_to_match=idx,
        expected_input_script_hex=VAULT_SPK,
    )
    assert not res.ok and "0xFFFFFFFF" in res.reason


def test_rejects_bad_sighash():
    """SIGHASH_NONE / SIGHASH_SINGLE / ANYONECANPAY are dangerous in a
    multi-party setting."""
    template, idx = _normal_template()
    for bad in (0x02, 0x03, 0x81, 0x82, 0x83):
        res = check(
            template=template,
            inputs=[_inp("deadbeef", sighash=bad)],
            outputs=[_out(99_000)],
            tx_lock_time=0,
            leaf_to_match=idx,
            expected_input_script_hex=VAULT_SPK,
        )
        assert not res.ok, f"sighash 0x{bad:02x} should reject"
        assert "sighash" in res.reason.lower()


def test_rejects_input_utxo_not_vault():
    """The UTXO being spent must be the vault's own scriptPubKey,
    otherwise an attacker has slipped in a different vault's coin."""
    template, idx = _normal_template()
    foreign_spk = "5120" + "ff" * 32
    res = check(
        template=template,
        inputs=[_inp("deadbeef", spk=foreign_spk)],
        outputs=[_out(99_000)],
        tx_lock_time=0,
        leaf_to_match=idx,
        expected_input_script_hex=VAULT_SPK,
    )
    assert not res.ok and "does not match this vault" in res.reason


def test_rejects_negative_fee():
    """Outputs > inputs would create coins out of thin air."""
    template, idx = _normal_template()
    res = check(
        template=template,
        inputs=[_inp("deadbeef", value=10_000)],
        outputs=[_out(20_000)],
        tx_lock_time=0,
        leaf_to_match=idx,
        expected_input_script_hex=VAULT_SPK,
    )
    assert not res.ok and "Negative fee" in res.reason


# ---------------------------------------------------------------------------
# leaf_script_index helper
# ---------------------------------------------------------------------------


def test_leaf_script_index_normalizes_case():
    """Hex keys are lowercased so case-insensitive matching works."""
    leaf = LeafMatch(kind=TemplateKind.NORMAL, quorum=1, keys=["a" * 64])
    template = TemplateMatch(leaves=[leaf])
    idx = leaf_script_index(template, [("DEADbeef", leaf)])
    assert "deadbeef" in idx
    assert "DEADbeef" not in idx
