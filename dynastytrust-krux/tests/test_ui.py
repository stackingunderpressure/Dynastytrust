"""ui.py smoke tests with a mock Krux context.

The Krux runtime (display / input / qr_capture / menu helpers) is not
installed when running this test suite. We feed in a minimal duck-typed
context so we can exercise the orchestration code (which calls
``ctx.confirm``, ``ctx.menu``, etc.) without rendering on a screen.

Real on-device rendering is verified in the firmware integration phase
against the Krux Pygame simulator.
"""
from __future__ import annotations

from typing import Any, List, Optional

import pytest

from krux.dynasty import (
    GuardCheckResult,
    LeafMatch,
    TemplateKind,
    TemplateMatch,
)
from krux.dynasty.ui import (
    ConfirmScreen,
    PathChooserScreen,
    _BRANCH_LABEL,
    _sats_to_btc,
    run_signing_flow,
)


class MockDisplay:
    def __init__(self):
        self.flashes: List[str] = []
    def flash_text(self, msg):
        self.flashes.append(msg)


class MockCtx:
    """Minimal Krux ctx duck-type: confirm + menu + display."""
    def __init__(self, confirm_result=True, menu_choice=0):
        self.display = MockDisplay()
        self._confirm_result = confirm_result
        self._menu_choice = menu_choice
        self.last_confirm_text: Optional[str] = None
        self.last_menu_choices: Optional[List[str]] = None

    def confirm(self, text):
        self.last_confirm_text = text
        return self._confirm_result

    def menu(self, prompt, choices):
        self.last_menu_choices = list(choices)
        return self._menu_choice


# ---------------------------------------------------------------------------
# _sats_to_btc -- short-string formatting for the small screen
# ---------------------------------------------------------------------------


def test_sats_to_btc_drops_trailing_zeros():
    assert _sats_to_btc(100_000_000) == "1"
    assert _sats_to_btc(150_000_000) == "1.5"
    assert _sats_to_btc(100_000) == "0.001"
    assert _sats_to_btc(0) == "0"
    assert _sats_to_btc(1) == "0.00000001"


# ---------------------------------------------------------------------------
# ConfirmScreen
# ---------------------------------------------------------------------------


def _result_ok(branch=TemplateKind.NORMAL, fee=1_000, dest=80_000, change=19_000,
               warnings=None) -> GuardCheckResult:
    return GuardCheckResult(
        ok=True, branch=branch,
        warnings=warnings or [],
        fee_sats=fee, destination_sats=dest, change_sats=change,
        total_in_sats=dest + fee + change, total_out_sats=dest + change,
    )


def test_confirm_screen_renders_branch_label():
    ctx = MockCtx(confirm_result=True)
    res = _result_ok(branch=TemplateKind.RECOVERY)
    ok = ConfirmScreen(ctx, res, destination_summary="bc1q12...abc456").run()
    assert ok is True
    assert _BRANCH_LABEL[TemplateKind.RECOVERY] in ctx.last_confirm_text
    assert "bc1q12...abc456" in ctx.last_confirm_text
    assert "Send: 0.0008 BTC" in ctx.last_confirm_text  # 80_000 sats
    assert "Fee:  0.00001 BTC" in ctx.last_confirm_text


def test_confirm_screen_user_cancels():
    ctx = MockCtx(confirm_result=False)
    res = _result_ok()
    ok = ConfirmScreen(ctx, res).run()
    assert ok is False


def test_confirm_screen_renders_warnings():
    ctx = MockCtx(confirm_result=True)
    res = _result_ok(warnings=["High fee: 50000 sats is 50.0%"])
    ConfirmScreen(ctx, res).run()
    assert "! High fee" in ctx.last_confirm_text


def test_confirm_screen_skips_change_line_when_zero():
    ctx = MockCtx(confirm_result=True)
    res = _result_ok(change=0)
    ConfirmScreen(ctx, res).run()
    assert "Change kept" not in ctx.last_confirm_text


def test_confirm_screen_rejects_when_guard_failed():
    ctx = MockCtx(confirm_result=True)  # would say yes, but never asked
    bad = GuardCheckResult(ok=False, reason="something broke")
    ok = ConfirmScreen(ctx, bad).run()
    assert ok is False
    assert any("Refused" in f for f in ctx.display.flashes)


# ---------------------------------------------------------------------------
# PathChooserScreen
# ---------------------------------------------------------------------------


def _full_template():
    return TemplateMatch(leaves=[
        LeafMatch(kind=TemplateKind.NORMAL, quorum=2, keys=["a" * 64]),
        LeafMatch(kind=TemplateKind.RECOVERY, quorum=1, keys=["a" * 64],
                  absolute_locktime=26_000),
        LeafMatch(kind=TemplateKind.INHERITANCE, quorum=2, keys=["d" * 64],
                  absolute_locktime=100_000),
    ])


def test_path_chooser_lists_every_branch_label():
    ctx = MockCtx(menu_choice=1)
    template = _full_template()
    PathChooserScreen(ctx, template, current_tip=900_000).run()
    assert ctx.last_menu_choices is not None
    text = "\n".join(ctx.last_menu_choices)
    assert _BRANCH_LABEL[TemplateKind.NORMAL] in text
    assert _BRANCH_LABEL[TemplateKind.RECOVERY] in text
    assert _BRANCH_LABEL[TemplateKind.INHERITANCE] in text


def test_path_chooser_returns_chosen_kind():
    ctx = MockCtx(menu_choice=1)  # Recovery (index 1)
    chosen = PathChooserScreen(ctx, _full_template()).run()
    assert chosen is TemplateKind.RECOVERY


def test_path_chooser_user_cancels_returns_none():
    ctx = MockCtx(menu_choice=None)
    chosen = PathChooserScreen(ctx, _full_template()).run()
    assert chosen is None


# ---------------------------------------------------------------------------
# run_signing_flow composition
# ---------------------------------------------------------------------------


def test_run_signing_flow_happy_path_calls_confirm():
    ctx = MockCtx(confirm_result=True)
    res = _result_ok()
    template = TemplateMatch(leaves=[res.branch and LeafMatch(
        kind=TemplateKind.NORMAL, quorum=1, keys=["a" * 64])])
    ok = run_signing_flow(ctx, template, res, destination_summary="x")
    assert ok is True


def test_run_signing_flow_routes_missing_leaf_to_path_chooser():
    """When the guard rejected with the 'does not specify which leaf'
    reason, run_signing_flow must call the chooser, then bail (the
    firmware re-runs the guard with the chosen leaf)."""
    ctx = MockCtx(menu_choice=0)
    bad = GuardCheckResult(
        ok=False, reason="Input 0: PSBT does not specify which leaf to spend"
    )
    template = _full_template()
    ok = run_signing_flow(ctx, template, bad)
    assert ok is False
    # User got the path chooser
    assert ctx.last_menu_choices is not None


def test_run_signing_flow_general_rejection_skips_chooser():
    """Other rejections show the reason and abort -- no chooser."""
    ctx = MockCtx(confirm_result=True)
    bad = GuardCheckResult(ok=False, reason="UTXO does not match this vault")
    template = _full_template()
    ok = run_signing_flow(ctx, template, bad)
    assert ok is False
    assert ctx.last_menu_choices is None
    assert any("Refused" in f for f in ctx.display.flashes)
