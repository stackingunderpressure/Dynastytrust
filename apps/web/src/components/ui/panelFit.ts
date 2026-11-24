import type { CSSProperties } from 'react';

/**
 * Every pop-up window's panel spreads this, so it always fits the part of
 * the screen you can actually see and scrolls inside itself.
 *
 * Operator, 2026-11-24 (the recovery-phrase window on a phone): "it gets
 * stuck down there you can't find the button to keep going". The panels were
 * capped at 92vh. On a phone, vh is measured with the browser's bars hidden,
 * so when the bars show, the bottom of a 92vh panel -- its last button --
 * sits under them and cannot be scrolled to. dvh follows the bars. Two panels
 * had no cap at all and simply ran off the screen.
 * scripts/test-no-viewport-traps.mjs fails the build if either comes back.
 */
export const PANEL_FIT: CSSProperties = {
  maxHeight: 'calc(100dvh - 32px)',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
};
