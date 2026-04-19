"""PSBT-to-GuardInput adapter.

Bridges the Krux signing flow (which works in embit PSBT objects) to
the policy guard (which works in plain dataclasses). The Phase 3
firmware integration is essentially:

    template, leaf_to_match = classify_with_scripts(wallet.descriptor)
    guard_in, guard_out, lock_time, expected_spk = adapt(psbt, wallet.descriptor)
    result = guard.check(template, guard_in, guard_out, lock_time,
                        leaf_to_match, expected_spk)
    if not result.ok:
        ui.show_rejection(result.reason)
        return  # do NOT call psbt.sign_with(...)
    ui.confirm(result)  # branch label, fee, destination, change check
    if user_confirmed:
        psbt.sign_with(seed)

This module owns the field-extraction details so the firmware patch
is small and the unit tests target this layer specifically.
"""
from __future__ import annotations

from typing import List, Tuple

from embit.descriptor import Descriptor
from embit.psbt import PSBT

from .policy_guard import GuardInput, GuardOutput


def adapt(psbt: PSBT, descriptor: Descriptor) -> Tuple[
    List[GuardInput], List[GuardOutput], int, str
]:
    """Convert an embit PSBT into guard-shaped inputs/outputs.

    Returns ``(guard_inputs, guard_outputs, tx_lock_time, expected_spk_hex)``.

    Per-input rules:
      - ``leaf_script_hex`` is the raw script bytes of the tap leaf this
        input intends to satisfy (the BIP 371 PSBT_IN_TAP_LEAF_SCRIPT
        field, minus the leaf-version prefix). If the input has zero or
        more than one tap leaf populated, ``leaf_script_hex`` is set to
        ``None`` and the guard rejects -- ambiguity is failure.
      - ``utxo_script_pubkey_hex`` and ``value_sats`` come from the
        ``witness_utxo`` field. If the input lacks a witness UTXO we
        feed an empty string + 0; the guard's ``expected_input_script_hex``
        check will reject it.
      - ``sequence`` comes from the unsigned tx's vin nSequence.
      - ``sighash_type`` defaults to ``0x00`` (taproot SIGHASH_DEFAULT)
        when the field is unset.

    Per-output rules:
      - ``script_pubkey_hex`` and ``value_sats`` come from the
        unsigned tx's vout.
      - ``is_change`` is determined by ``descriptor.owns(output_scope)``
        which checks the BIP32 derivation paths the coordinator
        promised; an output that doesn't derive from this descriptor
        is treated as a destination (not change).
    """
    expected_spk_hex = descriptor.script_pubkey().data.hex().lower()

    guard_inputs: List[GuardInput] = []
    for idx, inp in enumerate(psbt.inputs):
        # tap_leaf_script: pick the single leaf the input intends to
        # spend. embit stores the BIP 371 entries as an OrderedDict
        # mapping (script_bytes, leaf_version) -> [leaf_hashes]. A
        # well-formed coordinator should populate exactly one entry
        # per input (the chosen leaf); zero or more than one is a
        # signal we shouldn't trust.
        tap_scripts = list(inp.taproot_scripts.keys())
        if len(tap_scripts) == 1:
            leaf_script_bytes, _leaf_version = tap_scripts[0]
            leaf_hex = leaf_script_bytes.hex().lower()
        else:
            leaf_hex = None

        # witness_utxo: the UTXO being spent. Required for taproot
        # signing per BIP 341; if a coordinator omits it we cannot
        # verify the script, so feed sentinels and let the guard reject.
        wu = inp.witness_utxo
        if wu is None:
            utxo_spk_hex = ""
            value_sats = 0
        else:
            utxo_spk_hex = wu.script_pubkey.data.hex().lower()
            value_sats = wu.value

        guard_inputs.append(GuardInput(
            sequence=psbt.tx.vin[idx].sequence,
            sighash_type=inp.sighash_type if inp.sighash_type is not None else 0x00,
            leaf_script_hex=leaf_hex,
            utxo_script_pubkey_hex=utxo_spk_hex,
            value_sats=value_sats,
        ))

    guard_outputs: List[GuardOutput] = []
    for idx, out_scope in enumerate(psbt.outputs):
        vout = psbt.tx.vout[idx]
        try:
            is_change = descriptor.owns(out_scope)
        except Exception:
            # If owns() raises (descriptor incompatible with this output
            # shape, missing derivation info, etc.) treat as not-change.
            # Worst case: a true change output is shown to the user as
            # an external destination -- the user sees more cautious
            # data, not less.
            is_change = False
        guard_outputs.append(GuardOutput(
            script_pubkey_hex=vout.script_pubkey.data.hex().lower(),
            value_sats=vout.value,
            is_change=is_change,
        ))

    return guard_inputs, guard_outputs, psbt.tx.locktime, expected_spk_hex
