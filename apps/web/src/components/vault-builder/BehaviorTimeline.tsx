import { blocksToHuman } from '../../lib/blocks';
import { colors, radii } from '../../theme';

// One spendable path on a vault's timeline -- who can spend it, how many
// signatures it needs, and when it becomes reachable. Shared shape for
// any vault whose spend paths aren't just the standard founders-now /
// recovery / inheritance three leaves (today: Dynasty Bloc's decaying
// ladder).
export interface SpendLeg {
  label: string;
  who: string;
  afterBlocks: number; // 0 = immediate
  requiredSigners: number;
  meaning: string;
  weak?: boolean; // floor warning: a single weak key would be enough
}

// "What this vault does over time": a plain-language timeline of every
// spend path, grouped by when it unlocks. Relocated out of
// BlocBuilder.tsx so both the wizard's Configure step (live preview
// while tuning) and VaultDetail's Bloc branch (the vault's real, saved
// behavior) share one implementation. The floor warning is the
// educate-out-of-a-bad-choice guardrail: a decay rung that would let one
// kid spend entirely alone.
//
// floorWarning/kidCount are Bloc's own original shape (kept as-is, no
// behavior change, for its one existing call site). floorWarningText is
// the generalization for every other caller -- the generic leaf-list
// vault's decay-enabled paths aren't always about "kids," so a fixed
// Bloc-flavored sentence would be misleading there; a caller that already
// knows its own plain-language warning passes the finished sentence
// directly instead. Either mechanism renders the same way; a caller
// should use exactly one of them, not both.
export function BehaviorTimeline({ legs, floorWarning, kidCount, floorWarningText }: {
  legs: SpendLeg[];
  floorWarning?: boolean;
  kidCount?: number;
  floorWarningText?: string;
}) {
  const groups: { afterBlocks: number; legs: SpendLeg[] }[] = [];
  for (const leg of legs) {
    const g = groups.find(x => x.afterBlocks === leg.afterBlocks);
    if (g) g.legs.push(leg);
    else groups.push({ afterBlocks: leg.afterBlocks, legs: [leg] });
  }
  return (
    <div>
      {groups.map((g, gi) => {
        const immediate = g.afterBlocks === 0;
        const accent = immediate ? colors.gold : colors.blue;
        return (
          <div key={gi} style={{ display: 'flex', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ width: 12, height: 12, borderRadius: 6, background: accent, marginTop: 5, flex: '0 0 auto' }} />
              {gi < groups.length - 1 && <div style={{ width: 2, flex: 1, background: colors.border, minHeight: 20 }} />}
            </div>
            <div style={{ paddingBottom: 16, flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: accent, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {immediate ? 'Now -- no waiting' : `After ${blocksToHuman(g.afterBlocks)}`}
              </div>
              {g.legs.map((leg, li) => (
                <div key={li} style={{ marginTop: 7 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: leg.weak ? colors.red : colors.text }}>
                    {leg.label}{leg.weak ? '  (weakest point)' : ''}
                  </div>
                  <div style={{ fontSize: 12, color: colors.sub }}>{leg.who}</div>
                  <div style={{ fontSize: 12, color: colors.muted, lineHeight: 1.4 }}>{leg.meaning}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {(floorWarning || floorWarningText) && (
        <div style={{ marginTop: 6, padding: '10px 14px', borderRadius: radii.md, background: colors.red + '11', border: `1px solid ${colors.red}33`, color: colors.red, fontSize: 12, lineHeight: 1.5 }}>
          {floorWarningText ??
            `Heads up: the kid ladder eventually lets a SINGLE kid key spend alone (1 of ${kidCount}). If the kids hold phone keys, consider a decay floor of 2 or higher -- so no one lost or stolen phone is ever enough on its own.`}
        </div>
      )}
    </div>
  );
}
