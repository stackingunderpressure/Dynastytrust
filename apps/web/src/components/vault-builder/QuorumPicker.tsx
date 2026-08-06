import { colors, fonts, radii } from '../../theme';

// "M of N" numbered-button quorum selector. Relocated out of
// PolicyBuilder.tsx (was duplicated near-verbatim in BlocBuilder.tsx) so
// both the unified wizard and VaultDetail's Bloc behavior displays share
// one implementation.
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
    <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: colors.muted, marginRight: 4 }}>Required:</span>
      {Array.from({ length: max }, (_, i) => i + 1).map(n => (
        <button
          key={n}
          onClick={() => onChange(n)}
          style={{
            width: 34,
            height: 34,
            borderRadius: radii.md,
            border: '1px solid',
            borderColor: value === n ? color : colors.border,
            background: value === n ? color + '22' : 'transparent',
            color: value === n ? color : colors.muted,
            fontWeight: 700,
            fontSize: 14,
            cursor: 'pointer',
            fontFamily: fonts.sans,
          }}
        >
          {n}
        </button>
      ))}
      <span style={{ fontSize: 12, color: colors.muted }}>of {max}</span>
    </div>
  );
}
