"""DynastyTrust trust-mode signing hook for Krux.

Drop this file at ``src/krux/dynasty_signing_hook.py`` in your Krux
fork after applying the integration patch from INTEGRATION.md. The
upstream ``krux/psbt.py`` modification calls ``policy_guard_check``
before invoking ``self.psbt.sign_with(seed)``.

This file is the only firmware-side glue layer. All policy logic
lives in the upstream-agnostic :mod:`krux.dynasty` package.
"""
from .dynasty import (
    UnsupportedError,
    adapt,
    check,
    classify_with_scripts,
)
from .dynasty.ui import ConfirmScreen, PathChooserScreen, _BRANCH_LABEL


def policy_guard_check(ctx, wallet, psbt) -> bool:
    """Run the full trust-mode pre-sign validation flow.

    Returns:
        True if the operator has confirmed the spend; the firmware
            then proceeds to call psbt.sign_with(seed).
        False on any rejection or operator cancel; the firmware aborts.

    Architecture note: this function never touches private keys. It
    only inspects the PSBT shape, runs the policy guard, and shows
    user-confirmation screens. Signing happens after this returns.
    """
    descriptor = wallet.descriptor

    # 1. Re-classify the descriptor on every signing attempt so that a
    #    swapped descriptor (e.g. an attacker editing the SD card)
    #    can't bypass the gate. The wallet's stored allowlist record
    #    must still match the descriptor's digest; the wallet loader
    #    confirmed this at load time, but we re-derive here for
    #    defense-in-depth.
    try:
        template, leaf_to_match = classify_with_scripts(descriptor)
    except UnsupportedError as e:
        ctx.display.flash_text("Refused: " + str(e))
        return False

    # 2. Convert the PSBT into guard-shaped dataclasses.
    inputs, outputs, lock_time, expected_spk = adapt(psbt, descriptor)

    # 3. Run the policy guard.
    result = check(
        template=template,
        inputs=inputs,
        outputs=outputs,
        tx_lock_time=lock_time,
        leaf_to_match=leaf_to_match,
        expected_input_script_hex=expected_spk,
    )

    # 4. Special-case: the guard rejected because no leaf was specified.
    #    Offer the operator a path-chooser, then let them re-coordinate
    #    the PSBT externally (we do NOT mutate the PSBT here -- the
    #    coordinator must rebuild it with the chosen leaf populated).
    if not result.ok and "does not specify which leaf" in (result.reason or ""):
        chooser = PathChooserScreen(ctx, template)
        chosen = chooser.run()
        if chosen is not None:
            ctx.display.flash_text(
                f"Tell coordinator to use {_BRANCH_LABEL[chosen]} leaf"
            )
        return False

    # 5. Final confirmation.
    destination_summary = _summarize_destinations(psbt, outputs)
    confirmer = ConfirmScreen(
        ctx,
        result,
        destination_summary=destination_summary,
    )
    return confirmer.run()


def _summarize_destinations(psbt, outputs) -> str:
    """Render the first non-change destination as 'addr_first8...addr_last6'.

    Multiple non-change outputs are listed as 'N destinations'. The
    confirmation screen renders this single-line so we keep it short.
    """
    from embit.networks import NETWORKS
    from embit.script import Script

    externals = [(i, o) for i, o in enumerate(outputs) if not o.is_change]
    if not externals:
        return "(no external destinations)"
    if len(externals) > 1:
        return f"{len(externals)} destinations"
    idx, _go = externals[0]
    spk = psbt.tx.vout[idx].script_pubkey
    try:
        # Try mainnet first; if it doesn't render, try testnet/signet/regtest.
        for net_key in ("main", "test", "signet", "regtest"):
            try:
                addr = spk.address(NETWORKS[net_key])
                if addr:
                    return addr[:8] + "..." + addr[-6:]
            except Exception:
                continue
    except Exception:
        pass
    return spk.data.hex()[:12] + "..." + spk.data.hex()[-6:]
