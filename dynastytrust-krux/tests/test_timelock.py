"""Timelock label formatting tests.

Confirms small-screen-friendly labels for every duration bucket
plus the three modes of ``format_unlock`` (chain tip unknown,
already past, future).
"""
from __future__ import annotations

import pytest

from krux.dynasty.timelock import (
    BLOCKS_PER_DAY,
    BLOCKS_PER_HOUR,
    BLOCKS_PER_MONTH,
    BLOCKS_PER_WEEK,
    BLOCKS_PER_YEAR,
    blocks_to_label,
    format_unlock,
)


# ---------------------------------------------------------------------------
# blocks_to_label
# ---------------------------------------------------------------------------


def test_label_zero_or_negative():
    assert blocks_to_label(0) == "now"
    assert blocks_to_label(-5) == "now"


def test_label_under_hour_shows_blocks():
    assert blocks_to_label(1) == "~1 blocks"
    assert blocks_to_label(BLOCKS_PER_HOUR - 1) == f"~{BLOCKS_PER_HOUR - 1} blocks"


def test_label_under_day_shows_hours():
    assert blocks_to_label(BLOCKS_PER_HOUR) == "~1 hour"
    assert blocks_to_label(BLOCKS_PER_HOUR * 5) == "~5 hours"


def test_label_under_week_shows_days():
    assert blocks_to_label(BLOCKS_PER_DAY) == "~1 day"
    assert blocks_to_label(BLOCKS_PER_DAY * 3) == "~3 days"


def test_label_under_month_shows_weeks():
    assert blocks_to_label(BLOCKS_PER_WEEK) == "~1 week"
    assert blocks_to_label(BLOCKS_PER_WEEK * 3) == "~3 weeks"


def test_label_under_year_shows_months():
    assert blocks_to_label(BLOCKS_PER_MONTH) == "~1 month"
    assert blocks_to_label(BLOCKS_PER_MONTH * 6) == "~6 months"


def test_label_over_year_shows_years_or_decimal():
    assert blocks_to_label(BLOCKS_PER_YEAR) == "~1 year"
    # 2 years -> "2.0 years" via the decimal branch (>= 1.5)
    assert blocks_to_label(BLOCKS_PER_YEAR * 2) == "~2.0 years"
    assert blocks_to_label(BLOCKS_PER_YEAR * 5) == "~5.0 years"


def test_label_short_dynastytrust_window():
    """26,000 blocks (~6 month recovery floor) should land in months."""
    assert blocks_to_label(26_000) == "~6 months"


# ---------------------------------------------------------------------------
# format_unlock
# ---------------------------------------------------------------------------


def test_format_unlock_unknown_tip_returns_absolute():
    out = format_unlock(925_300, current_tip=None)
    assert "925,300" in out
    assert "chain tip unknown" in out


def test_format_unlock_already_past():
    out = format_unlock(900_000, current_tip=950_000)
    assert "spendable now" in out
    assert "900,000" in out


def test_format_unlock_future_with_tip():
    out = format_unlock(900_000 + 26_000, current_tip=900_000)
    assert "unlocks in" in out
    assert "month" in out
    assert "926,000" in out


def test_format_unlock_one_block_past():
    """Tip exactly at the locktime: spendable now (CLTV semantics: lock
    time N means the tx is valid only when block height >= N, i.e. N
    itself counts)."""
    out = format_unlock(100_000, current_tip=100_000)
    assert "spendable now" in out
