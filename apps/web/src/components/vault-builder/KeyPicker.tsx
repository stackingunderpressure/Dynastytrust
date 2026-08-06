import type { CSSProperties } from 'react';
import type { LocalKey } from '../../lib/keystore';
import type { SelectedKey } from '../../lib/descriptor-keys';
import { colors, fonts, radii } from '../../theme';

// The canonical `<select>` styling used across every vault-builder form
// control. Relocated out of PolicyBuilder.tsx -- CLAUDE.md used to point
// at PolicyBuilder as "the canonical example" for this pattern while
// BlocBuilder.tsx carried its own copy; now there's exactly one.
export const selectStyle: CSSProperties = {
  width: '100%',
  padding: '11px 13px',
  background: colors.input,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.md,
  color: colors.text,
  fontSize: 16, // iOS Safari zooms on focus below 16px
  fontFamily: fonts.sans,
  boxSizing: 'border-box',
};

// Selected-key chips + an "add from available" dropdown. Relocated out of
// PolicyBuilder.tsx (was duplicated near-verbatim in BlocBuilder.tsx for
// its parent/kid roles). The role-initial badge is now derived from
// `role` generically instead of a hardcoded founder/heir ('F'/'H') check,
// so it reads correctly for every role this app has (founder, heir,
// protector, consent, parent, kid).
export function KeyPicker({
  selected,
  available,
  onAdd,
  onRemove,
  role,
  accentColor,
}: {
  selected: SelectedKey[];
  available: LocalKey[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  role: string;
  accentColor: string;
}) {
  return (
    <div>
      {selected.map(k => (
        <div
          key={k.keyId}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: colors.inset,
            borderRadius: radii.md,
            padding: '10px 14px',
            border: `1px solid ${accentColor}44`,
            marginBottom: 6,
          }}
        >
          <span style={{ fontSize: 16 }}>{role.charAt(0).toUpperCase()}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: colors.text }}>{k.label}</div>
            <div style={{ fontSize: 11, color: colors.muted }}>
              <span style={{ color: accentColor }}>{k.persona}</span>
              {' . '}
              {k.fingerprint}
              {' . '}
              {k.network}
            </div>
          </div>
          <button
            onClick={() => onRemove(k.keyId)}
            style={{
              background: 'none',
              border: 'none',
              color: colors.muted,
              cursor: 'pointer',
              fontSize: 16,
            }}
          >
            x
          </button>
        </div>
      ))}
      {available.length > 0 && (
        <select
          style={{ ...selectStyle, color: colors.muted }}
          value=""
          onChange={e => {
            if (e.target.value) onAdd(e.target.value);
          }}
        >
          <option value="">+ Add {role} key...</option>
          {available.map(k => (
            <option key={k.keyId} value={k.keyId}>
              [{k.persona}] {k.label} ({k.fingerprint} . {k.network})
            </option>
          ))}
        </select>
      )}
      {!available.length && !selected.length && (
        <p style={{ fontSize: 13, color: colors.muted }}>
          No active keys available yet -- generate or import one below.
        </p>
      )}
    </div>
  );
}
