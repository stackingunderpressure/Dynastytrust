"""Timelock formatting -- "absolute block X" -> human label.

Krux has no clock and no internet. The user must supply the current
chain tip (typed in or scanned from a QR) for these helpers to render
relative durations. When the tip is unknown, the helpers fall back to
showing the absolute block height.

These helpers are used on the device's confirmation screen so the
operator sees, e.g., "unlocks in ~6 months" rather than just
"after block 925,300".

Conversion uses the conventional 10-minutes-per-block average.
Bitcoin's actual cadence varies per epoch but 10 min/block is the
right round number for human-language UX. The helpers never claim
precision they don't have -- "~6 months" not "exactly 6 months".
"""
from __future__ import annotations

from typing import Optional

# Average blocks per period at 10 minutes per block. Used for
# rendering only; never used as a security parameter.
BLOCKS_PER_HOUR = 6
BLOCKS_PER_DAY = 144
BLOCKS_PER_WEEK = 1_008
BLOCKS_PER_MONTH = 4_320  # 30 days
BLOCKS_PER_YEAR = 52_560  # 365 days


def blocks_to_label(blocks: int) -> str:
    """Render a positive block-count delta as "~N <unit>".

    Picks the largest unit whose count is at least 1 so labels stay
    short (signers have small screens). Negative or zero deltas
    return "now".
    """
    if blocks <= 0:
        return "now"
    if blocks < BLOCKS_PER_HOUR:
        return f"~{blocks} blocks"
    if blocks < BLOCKS_PER_DAY:
        n = round(blocks / BLOCKS_PER_HOUR)
        return f"~{n} hour{'s' if n != 1 else ''}"
    if blocks < BLOCKS_PER_WEEK:
        n = round(blocks / BLOCKS_PER_DAY)
        return f"~{n} day{'s' if n != 1 else ''}"
    if blocks < BLOCKS_PER_MONTH:
        n = round(blocks / BLOCKS_PER_WEEK)
        return f"~{n} week{'s' if n != 1 else ''}"
    if blocks < BLOCKS_PER_YEAR:
        n = round(blocks / BLOCKS_PER_MONTH)
        return f"~{n} month{'s' if n != 1 else ''}"
    n_y = blocks / BLOCKS_PER_YEAR
    if n_y < 1.5:
        # "1 year" reads better than "1.0 years"
        return f"~{round(n_y)} year{'s' if round(n_y) != 1 else ''}"
    return f"~{n_y:.1f} years"


def format_unlock(absolute_block: int, current_tip: Optional[int]) -> str:
    """Render an absolute block-height locktime for the screen.

    With ``current_tip`` provided (the user-supplied chain height),
    returns one of:
      - "spendable now"    -- tip already past the lock
      - "unlocks in ~6 months at block 925,300"
    Without ``current_tip`` returns the bare absolute height with a
    note that the relative duration cannot be computed:
      - "at block 925,300 (chain tip unknown)"
    """
    fmt_block = f"{absolute_block:,}"
    if current_tip is None:
        return f"at block {fmt_block} (chain tip unknown)"
    if current_tip >= absolute_block:
        return f"spendable now (was block {fmt_block})"
    delta = absolute_block - current_tip
    return f"unlocks in {blocks_to_label(delta)} at block {fmt_block}"
