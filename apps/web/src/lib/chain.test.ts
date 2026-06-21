import { describe, it, expect } from 'vitest';
import { blocksToApproxLabel, approxWallclockDate } from './chain';

// Pure timelock-countdown labels. A wrong label here misrepresents when a
// recovery/inheritance path unlocks, so the bucket boundaries are pinned.
// (10 minutes per block: 1 day = 144 blocks.)
describe('blocksToApproxLabel', () => {
  it('reads "Available now" at or below zero', () => {
    expect(blocksToApproxLabel(0)).toBe('Available now');
    expect(blocksToApproxLabel(-1)).toBe('Available now');
  });

  it('reads in hours under a day', () => {
    expect(blocksToApproxLabel(6)).toBe('~1 hours'); // 60 min
    expect(blocksToApproxLabel(72)).toBe('~12 hours'); // half a day
  });

  it('reads in days from 1 day up to 60 days', () => {
    expect(blocksToApproxLabel(144)).toBe('~1 days'); // exactly 1 day
    expect(blocksToApproxLabel(4320)).toBe('~30 days'); // 30 days
  });

  it('crosses to months at 60 days', () => {
    expect(blocksToApproxLabel(8640)).toBe('~2 months'); // 60 days
    expect(blocksToApproxLabel(12960)).toBe('~3 months'); // 90 days
  });

  it('crosses to years at 365 days, one decimal', () => {
    expect(blocksToApproxLabel(52560)).toBe('~1.0 years'); // 365 days
    expect(blocksToApproxLabel(105120)).toBe('~2.0 years'); // 730 days
  });
});

describe('approxWallclockDate', () => {
  it('projects forward at 10 minutes per block', () => {
    const before = Date.now();
    const d = approxWallclockDate(144); // ~1 day out
    const delta = d.getTime() - before;
    // 144 blocks * 10 min * 60 s * 1000 ms = 86_400_000 ms (1 day),
    // allowing a small window for clock drift across the two reads.
    expect(delta).toBeGreaterThanOrEqual(86_400_000 - 50);
    expect(delta).toBeLessThanOrEqual(86_400_000 + 5_000);
  });

  it('returns now for zero blocks', () => {
    const before = Date.now();
    const d = approxWallclockDate(0);
    expect(Math.abs(d.getTime() - before)).toBeLessThan(5_000);
  });
});
