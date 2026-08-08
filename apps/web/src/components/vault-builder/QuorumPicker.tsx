import { colors, fonts } from '../../theme';

// "M of N" quorum selector. Relocated out of PolicyBuilder.tsx (was
// duplicated near-verbatim in BlocBuilder.tsx) so both the unified wizard
// and VaultDetail's Bloc behavior displays share one implementation.
//
// Redesigned for real thumbs: the old buttons were 34px (under the app's
// own 44pt tap-target standard) with a faint tinted-border selected state
// that was easy to miss, and the only readout was "N of M" in tiny type
// above the row. Buttons are now full 44px circles with a solid fill when
// selected, plus a plain-language sentence below the row so the number
// alone doesn't have to carry the meaning.
export function QuorumPicker({
  max,
  value,
  onChange,
  color,
}: {
  max: number;
  value: number;
  onChange: (n: number) => void;
  color: string;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {Array.from({ length: max }, (_, i) => i + 1).map(n => {
          const selected = value === n;
          return (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              aria-pressed={selected}
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                border: selected ? 'none' : `1px solid ${colors.border}`,
                background: selected ? color : colors.input,
                color: selected ? colors.bg : colors.muted,
                fontWeight: 800,
                fontSize: 16,
                fontFamily: fonts.sans,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'transform 100ms ease',
              }}
            >
              {n}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 13, color: colors.sub, marginTop: 10 }}>
        <span style={{ color, fontWeight: 700 }}>{value}</span> of {max} must agree to spend.
      </div>
    </div>
  );
}
