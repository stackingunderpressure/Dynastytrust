"""DynastyTrust trust-mode signing hook for Krux.

Drop this file at ``src/krux/dynasty_signing_hook.py`` in your Krux
fork after applying the integration patch from INTEGRATION.md. The
upstream ``krux/psbt.py`` modification calls ``policy_guard_check``
before invoking ``self.psbt.sign_with(seed)``.

This hook is self-gating: it runs on every sign() call, but returns
True (pass-through, allow normal signing) for any wallet that isn't
a DynastyTrust-template vault provisioned on this device. So
patching Krux is a single one-line addition to psbt.py and nothing
else -- no wallet.py modification, no settings entries, no new
imports outside this file.
"""


def policy_guard_check(ctx, wallet, psbt) -> bool:
    """Run the full trust-mode pre-sign validation flow.

    Returns:
        True  -- either the wallet isn't in trust mode, or the
                 operator confirmed the spend. Upstream proceeds to
                 call psbt.sign_with(seed).
        False -- trust mode engaged AND the guard rejected OR the
                 operator cancelled. Upstream aborts without signing.

    Self-gating logic, in order:

      1. No descriptor on the wallet -> pass through.
      2. Descriptor doesn't classify as a DynastyTrust template ->
         pass through (normal Krux wallet).
      3. Descriptor classifies but device has no allowlist entry
         matching this descriptor's digest -> pass through (device
         not provisioned for this vault, treat as a normal signer).
      4. Descriptor matches a provisioned vault -> enforce trust
         mode: run the policy guard, show the user-confirmation
         flow, return the operator's decision.

    This function never touches private keys. Signing happens in
    the caller after this returns True.
    """
    descriptor = getattr(wallet, "descriptor", None)
    if descriptor is None:
        return True

    # Imports deferred so a broken /sd or a stale install doesn't
    # crash every non-trust-mode signing attempt. Any ImportError
    # here means the dynasty package never landed on this device
    # and we should default-pass.
    try:
        from .dynasty import (
            UnsupportedError,
            adapt,
            check,
            classify_with_scripts,
            descriptor_hash,
            load as load_allowlist,
        )
        from .dynasty.ui import ConfirmScreen, PathChooserScreen, _BRANCH_LABEL
    except ImportError:
        return True

    try:
        template, leaf_to_match = classify_with_scripts(descriptor)
    except UnsupportedError:
        # Descriptor is not a DynastyTrust template. Not our concern.
        return True
    except Exception:
        # Anything weird with the descriptor shape -- default pass so
        # we never brick normal signing for a non-DT wallet due to our
        # own bugs.
        return True

    # Descriptor IS a DynastyTrust template. See if THIS device has
    # been provisioned for it.
    try:
        from .krux_settings import Settings
        al_path = Settings().persist.path("dynasty_allowlist.json")
    except Exception:
        al_path = "/sd/dynasty_allowlist.json"

    try:
        allowlist = load_allowlist(al_path)
    except Exception:
        # No allowlist file or corrupt -> treat as un-provisioned.
        return True

    digest = descriptor_hash(template)
    if not allowlist.find(digest):
        # DT-shaped descriptor but this isn't a vault we've been
        # provisioned for. Treat as a normal signing session; don't
        # refuse. (User may be testing; the device isn't in trust
        # mode for THIS vault.)
        return True

    # --- Provisioned match. Enforce trust mode from here on. ---

    inputs, outputs, lock_time, expected_spk = adapt(psbt, descriptor)

    result = check(
        template=template,
        inputs=inputs,
        outputs=outputs,
        tx_lock_time=lock_time,
        leaf_to_match=leaf_to_match,
        expected_input_script_hex=expected_spk,
    )

    # Path-chooser fallback when the guard complains about missing
    # leaf. User picks a branch; we don't mutate the PSBT here, we
    # tell them to re-coordinate.
    if not result.ok and "does not specify which leaf" in (result.reason or ""):
        chooser = PathChooserScreen(ctx, template)
        chosen = chooser.run()
        if chosen is not None:
            ctx.display.flash_text(
                "Tell coordinator to use " + _BRANCH_LABEL[chosen] + " leaf"
            )
        return False

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

    externals = [(i, o) for i, o in enumerate(outputs) if not o.is_change]
    if not externals:
        return "(no external destinations)"
    if len(externals) > 1:
        return str(len(externals)) + " destinations"
    idx, _go = externals[0]
    spk = psbt.tx.vout[idx].script_pubkey
    try:
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
