"""On-device UI helpers for the trust-mode signer.

This module is **structurally Krux-compatible** -- it imports from the
upstream Krux page module to slot into the existing UI conventions
(Page subclass, ``self.ctx.display`` for screen output, ``Menu`` for
choice prompts). It is **not exercised by the dynastytrust-krux test
suite**: the K210 emulator + display fixtures live in upstream Krux
and would pull in the entire firmware.

Three screens, each one short enough to fit on the K210's 240x240
display:

  - :class:`ProvisionScreen` -- one-time vault descriptor capture.
    Scans a descriptor QR, classifies it, computes the digest, and
    stores it in the allowlist along with the operator-supplied role.

  - :class:`PathChooserScreen` -- shown only on signer if the loaded
    PSBT is ambiguous (zero or multiple leaves populated). Lets the
    operator confirm the intended branch from a small menu. The
    classifier still has to accept the descriptor; this is purely a
    confirmation step the operator can refuse.

  - :class:`ConfirmScreen` -- the final pre-signing screen. Shows
    branch label, amount being sent, fee, change preservation check,
    and a one-tap confirm/reject.

The screens compose with two helpers from :mod:`policy_guard` and
:mod:`timelock` so they have nothing to do with PSBT internals.

When the upstream Krux integration patch (see ``firmware/`` README)
is applied, ``krux.psbt.PSBTSigner.sign()`` calls these screens via
the policy_guard layer. Until that patch lands the module is
unreachable on real hardware -- intentionally, for safety.
"""
from __future__ import annotations

from typing import List, Optional, Tuple

# Upstream Krux imports. These are NOT installed in the dynastytrust-krux
# package -- they resolve only when this module is vendored into the
# Krux firmware tree. We keep the imports inside class methods (lazy)
# so this file can be byte-compiled at package install time without
# the Krux runtime being available.
#
# from krux.pages import Page, Menu
# from krux.themes import theme
# from krux.input import BUTTON_ENTER, BUTTON_PAGE, BUTTON_PAGE_PREV

from .allowlist import Allowlist, Provisioning, save as save_allowlist
from .policy_guard import GuardCheckResult
from .templates import TemplateKind, TemplateMatch, descriptor_hash
from .timelock import format_unlock


_BRANCH_LABEL = {
    TemplateKind.NORMAL: "Normal trustee spend",
    TemplateKind.RECOVERY: "Recovery spend",
    TemplateKind.INHERITANCE: "Inheritance spend",
    TemplateKind.PROTECTOR: "Protector spend",
    TemplateKind.CONSENT: "Consent spend",
}


def _sats_to_btc(sats: int) -> str:
    """Render a sats value as a short BTC string for the small screen."""
    btc = sats / 1e8
    s = f"{btc:.8f}".rstrip("0").rstrip(".")
    return s if s else "0"


# ---------------------------------------------------------------------------
# ProvisionScreen
# ---------------------------------------------------------------------------


class ProvisionScreen:
    """Scan + confirm + save a vault descriptor.

    Caller flow (real Krux integration):

        screen = ProvisionScreen(ctx, allowlist_path)
        if screen.run():
            # device is now provisioned; refuse anything else
            ctx.display.flash_text("Provisioned for " + screen.provisioning.role)

    Behavior:

      1. Scan a descriptor QR (single-frame; descriptors are small).
      2. Try to classify. On reject, show the rejection message and
         abort -- the device stays un-provisioned.
      3. Compute the digest. Show the operator the digest's first +
         last 8 hex chars plus the leaf summary (Normal Q-of-N,
         Recovery in ~6 months, etc.).
      4. Prompt for the operator's role (founder/trustee/heir/protector/
         consent/viewer). Default offered based on whether the operator's
         own pubkey matches a key in any leaf.
      5. Optional human-readable label.
      6. Save the allowlist atomically.

    Returns ``True`` on successful provisioning, ``False`` on cancel.
    """

    def __init__(self, ctx, allowlist_path: str, allowlist: Allowlist):
        self.ctx = ctx
        self.allowlist_path = allowlist_path
        self.allowlist = allowlist
        self.provisioning: Optional[Provisioning] = None

    def run(self) -> bool:
        from .templates import classify, UnsupportedError
        from embit.descriptor import Descriptor

        # 1. Scan
        qr_str = self.ctx.qr_capture.run("Scan vault descriptor")
        if not qr_str:
            return False

        # 2. Parse + classify
        try:
            descriptor = Descriptor.from_string(qr_str.strip())
            template = classify(descriptor)
        except UnsupportedError as e:
            self.ctx.display.flash_text("Refused: " + str(e))
            return False
        except Exception as e:  # noqa: BLE001
            self.ctx.display.flash_text("Bad descriptor: " + str(e)[:40])
            return False

        # 3. Show the operator what they're about to commit to
        digest = descriptor_hash(template)
        if not self._confirm_summary(template, digest):
            return False

        # 4. Pick a role
        role = self._prompt_role(template)
        if role is None:
            return False

        # 5. Optional label
        label = self.ctx.input.run("Optional label", default="")

        # 6. Save
        prov = Provisioning(
            descriptor_hash=digest,
            role=role,
            label=label or "",
        )
        try:
            self.allowlist.add(
                prov,
                allow_multiple=self.allowlist.firmware_test_mode,
            )
            save_allowlist(self.allowlist, self.allowlist_path)
        except Exception as e:  # noqa: BLE001
            self.ctx.display.flash_text("Save failed: " + str(e)[:40])
            return False

        self.provisioning = prov
        self.ctx.display.flash_text(f"Provisioned as {role}")
        return True

    def _confirm_summary(self, template: TemplateMatch, digest: str) -> bool:
        lines = ["Confirm vault digest:", digest[:16] + "..." + digest[-8:]]
        for leaf in template.leaves:
            label = _BRANCH_LABEL[leaf.kind]
            quorum = f"{leaf.quorum}-of-{len(leaf.keys)}"
            extra = ""
            if leaf.absolute_locktime:
                extra = " @ block " + f"{leaf.absolute_locktime:,}"
            lines.append(f"- {label} {quorum}{extra}")
        return self.ctx.confirm("\n".join(lines))

    def _prompt_role(self, template: TemplateMatch) -> Optional[str]:
        # We could pre-select based on which leaf contains the operator's
        # local key, but that requires more glue with Krux's seed object;
        # leave as an upstream PR follow-up. For now offer a flat menu.
        choices = ["founder", "trustee", "heir", "protector", "consent", "viewer"]
        return self.ctx.menu("Pick this device's role", choices)


# ---------------------------------------------------------------------------
# PathChooserScreen
# ---------------------------------------------------------------------------


class PathChooserScreen:
    """Disambiguate when the PSBT didn't pick a leaf.

    Most coordinators do pick a leaf and this screen is skipped. When
    the loaded PSBT has zero or multiple ``taproot_scripts`` populated
    on at least one input, the firmware presents this menu so the
    operator can either pick a branch or reject. The chosen branch is
    fed back into the policy guard for re-validation.
    """

    def __init__(self, ctx, template: TemplateMatch, current_tip: Optional[int] = None):
        self.ctx = ctx
        self.template = template
        self.current_tip = current_tip

    def run(self) -> Optional[TemplateKind]:
        choices: List[Tuple[str, TemplateKind]] = []
        for leaf in self.template.leaves:
            label = _BRANCH_LABEL[leaf.kind]
            extra = ""
            if leaf.absolute_locktime:
                extra = " (" + format_unlock(leaf.absolute_locktime, self.current_tip) + ")"
            choices.append((label + extra, leaf.kind))
        labels = [c[0] for c in choices]
        idx = self.ctx.menu("Pick spending path", labels)
        if idx is None:
            return None
        return choices[idx][1]


# ---------------------------------------------------------------------------
# ConfirmScreen
# ---------------------------------------------------------------------------


class ConfirmScreen:
    """Final pre-signing confirmation screen.

    Shows everything the operator needs to make a yes/no decision:
    branch, amount, destination summary, fee, change preservation
    check, any policy-guard warnings.

    Returns ``True`` on confirm, ``False`` on reject.
    """

    def __init__(self, ctx, result: GuardCheckResult,
                 destination_summary: str = "", current_tip: Optional[int] = None):
        self.ctx = ctx
        self.result = result
        self.destination_summary = destination_summary
        self.current_tip = current_tip

    def run(self) -> bool:
        if not self.result.ok:
            self.ctx.display.flash_text("Refused: " + (self.result.reason or "unknown"))
            return False

        lines = [
            _BRANCH_LABEL[self.result.branch],
            "",
            f"Send: {_sats_to_btc(self.result.destination_sats)} BTC",
        ]
        if self.destination_summary:
            lines.append(f"To:   {self.destination_summary}")
        lines.append(f"Fee:  {_sats_to_btc(self.result.fee_sats)} BTC")
        if self.result.change_sats:
            lines.append(
                f"Change kept: {_sats_to_btc(self.result.change_sats)} BTC"
            )
        for warning in self.result.warnings:
            lines.append("! " + warning)

        return self.ctx.confirm("\n".join(lines))


# ---------------------------------------------------------------------------
# Public composition entry-point
# ---------------------------------------------------------------------------


def run_signing_flow(ctx, template: TemplateMatch,
                     guard_result: GuardCheckResult,
                     destination_summary: str = "",
                     current_tip: Optional[int] = None) -> bool:
    """Convenience composition for a typical signing flow.

    Krux's ``psbt.sign()`` integration calls this single function:
    if it returns True, proceed to call ``psbt.sign_with(seed)``;
    otherwise abort. PathChooser only fires when the guard reports
    a missing-leaf reason; otherwise we skip straight to the
    confirmation screen.
    """
    if not guard_result.ok and "does not specify which leaf" in (guard_result.reason or ""):
        # Operator picks; firmware re-runs guard with the chosen leaf
        chooser = PathChooserScreen(ctx, template, current_tip=current_tip)
        chosen = chooser.run()
        if chosen is None:
            return False
        # The firmware caller is responsible for re-running policy_guard.check
        # with the chosen leaf bound to every input. Until that re-validation
        # comes back ok, we must NOT proceed.
        ctx.display.flash_text("Re-validate then call run_signing_flow again")
        return False

    return ConfirmScreen(
        ctx,
        guard_result,
        destination_summary=destination_summary,
        current_tip=current_tip,
    ).run()
