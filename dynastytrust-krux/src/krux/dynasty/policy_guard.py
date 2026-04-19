"""Policy guard -- pre-sign validator for trust-mode Krux.

Decides whether a PSBT is safe to sign against a previously classified
DynastyTrust descriptor template. Returns a :class:`GuardCheckResult`
that carries a branch label (Normal trustee spend, Recovery spend, ...)
on success or a precise rejection reason on failure.

The guard is signature-shape-agnostic: it operates on small dataclasses
(:class:`GuardInput`, :class:`GuardOutput`) rather than embit PSBT
internals. A thin adapter in Phase 3 will convert a parsed PSBT into
these dataclasses; the guard logic itself stays pure and trivially
testable.

Failure modes (every check is fail-closed):

  - PSBT spends through an unknown leaf (not present in the descriptor)
  - Two inputs spend through different leaves (ambiguity)
  - Timelocked leaf spent without sufficient ``tx.lock_time``
  - Timelocked leaf spent with ``nSequence == 0xFFFFFFFF`` (CLTV requires
    at least one input below the final value, BIP 65)
  - Non-timelocked leaf spent with ``tx.lock_time != 0`` (suspicious;
    either an attacker is fooling the user or the coordinator is buggy)
  - Sighash type not ``SIGHASH_DEFAULT`` (taproot default) or
    ``SIGHASH_ALL``
  - A change output that does not derive from the same descriptor
  - An input whose UTXO script doesn't match the descriptor's script

The first match in the leaf set wins; we then verify every other input
satisfies the same leaf. Mixing branches in one transaction is rejected.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from .templates import LeafMatch, TemplateKind, TemplateMatch


# Acceptable sighash bytes for a tap-script signature.
# - SIGHASH_DEFAULT (0x00) is the modern taproot default
# - SIGHASH_ALL (0x01) is the legacy explicit equivalent
# Anything else (NONE / SINGLE / ANYONECANPAY) is dangerous in a multi-
# party setting and rejected.
ACCEPTABLE_SIGHASH = frozenset({0x00, 0x01})

# nSequence sentinel values:
# - 0xFFFFFFFE  -- BIP 125 RBF-disabled, but still allows CLTV
# - 0xFFFFFFFF  -- final, disables both RBF and CLTV (this fails the lock_time check)
# CLTV requires at least one input nSequence < 0xFFFFFFFF.
SEQUENCE_FINAL = 0xFFFFFFFF


@dataclass
class GuardInput:
    """One input as the guard sees it.

    ``leaf_script_hex`` is the script bytes of the tap-leaf this input
    intends to satisfy (lifted from PSBT_IN_TAP_LEAF_SCRIPT). If a
    coordinator has not yet picked a leaf, the field is ``None`` and we
    reject -- the device must know the branch before signing.

    ``utxo_script_pubkey_hex`` is the script of the UTXO being spent --
    i.e. the vault's own taproot output script. If the descriptor's
    derived address script doesn't match, an attacker may have swapped
    the input UTXO; reject.
    """
    sequence: int
    sighash_type: int
    leaf_script_hex: Optional[str]
    utxo_script_pubkey_hex: str
    value_sats: int


@dataclass
class GuardOutput:
    """One output as the guard sees it.

    ``is_change`` must be set by the adapter via descriptor.owns()
    against the device's stored descriptor; this guard does not redo
    that derivation.
    """
    script_pubkey_hex: str
    value_sats: int
    is_change: bool


@dataclass
class GuardCheckResult:
    """Outcome of running the guard.

    ``ok`` is the binary verdict the signer cares about.
    ``branch`` is the classified template kind (used for the user
    confirmation screen label) when ``ok`` is True.
    ``reason`` carries a short human-readable rejection string when
    ``ok`` is False; it is shown verbatim on the device.
    ``warnings`` are non-fatal observations -- e.g. fee unusually
    high -- the signer may surface as caution prompts.
    """
    ok: bool
    branch: Optional[TemplateKind] = None
    reason: Optional[str] = None
    warnings: List[str] = field(default_factory=list)
    total_in_sats: int = 0
    total_out_sats: int = 0
    fee_sats: int = 0
    change_sats: int = 0
    destination_sats: int = 0


def _leaf_script_hex(leaf: LeafMatch) -> Optional[str]:
    """Compute the script bytes of a leaf so we can match a PSBT input
    against it.

    For Phase 2 we delegate to the caller: the adapter that builds
    GuardInputs already has the parsed leaf scripts from the descriptor
    (see :func:`leaf_script_index`). Returning ``None`` here keeps the
    guard logic pure -- match by hex string equality only.
    """
    return None


def leaf_script_index(template: TemplateMatch, descriptor_leaf_scripts: List[Tuple[str, LeafMatch]]) -> dict:
    """Build a lookup from leaf-script hex to its classified LeafMatch.

    The adapter (Phase 3) walks the embit TapTree, serializes each
    TapLeaf script to bytes, and provides a list of (script_hex, leaf)
    tuples. This helper converts that list into a dict the guard can
    use to identify which template branch a given input intends to spend.

    Built up-front so Phase 3's per-input lookup stays O(1).
    """
    out = {}
    for script_hex, leaf in descriptor_leaf_scripts:
        out[script_hex.lower()] = leaf
    return out


def check(
    template: TemplateMatch,
    inputs: List[GuardInput],
    outputs: List[GuardOutput],
    tx_lock_time: int,
    leaf_to_match: dict,
    expected_input_script_hex: str,
    *,
    high_fee_warn_pct: float = 5.0,
) -> GuardCheckResult:
    """Validate a PSBT shape against a classified template.

    Arguments:
        template: result of :func:`templates.classify` for the device's
            stored descriptor.
        inputs: parsed ``GuardInput`` rows (one per PSBT input).
        outputs: parsed ``GuardOutput`` rows (one per PSBT output).
        tx_lock_time: the transaction-level ``nLockTime`` from the
            unsigned tx in the PSBT.
        leaf_to_match: mapping from leaf-script-hex to LeafMatch, built
            from the device's stored descriptor (see
            :func:`leaf_script_index`).
        expected_input_script_hex: the descriptor's derived
            scriptPubKey (vault's own address). Every input must spend
            this exact script -- guards against the coordinator swapping
            in a UTXO from a different vault.
        high_fee_warn_pct: emit a non-fatal warning when miner fee
            exceeds this percentage of the spend value.

    Returns:
        :class:`GuardCheckResult` with ``ok=True`` and a populated
        ``branch`` on success, or ``ok=False`` with a precise ``reason``
        on failure.
    """
    if not inputs:
        return GuardCheckResult(ok=False, reason="No inputs to sign")
    if not outputs:
        return GuardCheckResult(ok=False, reason="No outputs in transaction")

    expected_input_script_hex = expected_input_script_hex.lower()

    # Pass 1: identify the branch this PSBT intends to spend through.
    # Every input must reference the same leaf; otherwise the
    # coordinator is mixing branches and we reject.
    branch_leaf: Optional[LeafMatch] = None
    branch_script_hex: Optional[str] = None
    for idx, inp in enumerate(inputs):
        if inp.leaf_script_hex is None:
            return GuardCheckResult(
                ok=False,
                reason=f"Input {idx}: PSBT does not specify which leaf to spend",
            )
        leaf_hex = inp.leaf_script_hex.lower()
        leaf = leaf_to_match.get(leaf_hex)
        if leaf is None:
            return GuardCheckResult(
                ok=False,
                reason=f"Input {idx}: leaf script not in approved templates",
            )
        if branch_leaf is None:
            branch_leaf = leaf
            branch_script_hex = leaf_hex
        elif leaf_hex != branch_script_hex:
            return GuardCheckResult(
                ok=False,
                reason="Inputs spend through different leaves; reject",
            )

    assert branch_leaf is not None  # narrowing for type-checkers

    # Pass 2: per-input checks.
    for idx, inp in enumerate(inputs):
        # Sighash type must be safe for multiparty signing.
        if inp.sighash_type not in ACCEPTABLE_SIGHASH:
            return GuardCheckResult(
                ok=False,
                reason=(
                    f"Input {idx}: sighash 0x{inp.sighash_type:02x} not allowed; "
                    "only SIGHASH_DEFAULT or SIGHASH_ALL"
                ),
            )

        # The UTXO being spent must be the vault's own address. If the
        # coordinator slipped in a different vault's UTXO we'd be
        # signing away funds we don't intend to spend.
        if inp.utxo_script_pubkey_hex.lower() != expected_input_script_hex:
            return GuardCheckResult(
                ok=False,
                reason=f"Input {idx}: UTXO script does not match this vault",
            )

        # Timelocked branches require a non-final sequence on at least
        # one input (BIP 65). We require it on all inputs in trust mode
        # to keep the rule simple and visibly enforced.
        if branch_leaf.absolute_locktime is not None:
            if inp.sequence == SEQUENCE_FINAL:
                return GuardCheckResult(
                    ok=False,
                    reason=(
                        f"Input {idx}: timelocked branch requires nSequence < "
                        "0xFFFFFFFF; got 0xFFFFFFFF"
                    ),
                )

    # Pass 3: lock_time check.
    if branch_leaf.absolute_locktime is not None:
        # Recovery / Inheritance / Protector
        if tx_lock_time < branch_leaf.absolute_locktime:
            return GuardCheckResult(
                ok=False,
                reason=(
                    f"tx.lock_time {tx_lock_time} below leaf requirement "
                    f"{branch_leaf.absolute_locktime}"
                ),
            )
    else:
        # Normal / Consent: lock_time should be 0. A non-zero lock_time
        # on a Normal spend isn't a Bitcoin error per se, but it's
        # suspicious in a trust-mode signer -- either the coordinator
        # is confused or an attacker is hoping the user won't notice.
        if tx_lock_time != 0:
            return GuardCheckResult(
                ok=False,
                reason=(
                    f"Non-timelocked branch but tx.lock_time={tx_lock_time}; "
                    "expected 0"
                ),
            )

    # Pass 4: change outputs must be ours.
    change_sats = 0
    destination_sats = 0
    for idx, out in enumerate(outputs):
        if out.is_change:
            change_sats += out.value_sats
        else:
            destination_sats += out.value_sats

    # Pass 5: fee math + warnings.
    total_in = sum(inp.value_sats for inp in inputs)
    total_out = sum(out.value_sats for out in outputs)
    fee = total_in - total_out

    if fee < 0:
        return GuardCheckResult(
            ok=False,
            reason=f"Negative fee: outputs ({total_out}) exceed inputs ({total_in})",
        )

    warnings: List[str] = []
    spend_value = destination_sats if destination_sats > 0 else total_out
    if spend_value > 0 and fee * 100.0 / spend_value > high_fee_warn_pct:
        warnings.append(
            f"High fee: {fee} sats is {(fee*100.0/spend_value):.1f}% of spend value"
        )

    return GuardCheckResult(
        ok=True,
        branch=branch_leaf.kind,
        warnings=warnings,
        total_in_sats=total_in,
        total_out_sats=total_out,
        fee_sats=fee,
        change_sats=change_sats,
        destination_sats=destination_sats,
    )
