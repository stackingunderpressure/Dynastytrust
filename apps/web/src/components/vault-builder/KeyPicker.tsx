import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
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
  allKeys,
}: {
  selected: SelectedKey[];
  available: LocalKey[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  role: string;
  accentColor: string;
  // Full key list (selected + available + everything else), used only to
  // look up backedUp status -- SelectedKey itself doesn't carry it, since
  // it's shaped for what the compiler needs, not backup bookkeeping.
  allKeys?: LocalKey[];
}) {
  return (
    <div>
      {selected.map(k => {
        const backedUp = allKeys?.find(ak => ak.keyId === k.keyId)?.backedUp ?? true;
        return (
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
            <div style={{ fontSize: 14, fontWeight: 500, color: colors.text, display: 'flex', alignItems: 'center', gap: 6 }}>
              {k.label}
              {k.origin === 'tapit' && (
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    color: colors.gold,
                    border: `1px solid ${colors.gold}66`,
                    borderRadius: 4,
                    padding: '1px 5px',
                  }}
                >
                  TAPIT
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: colors.muted }}>
              <span style={{ color: accentColor }}>{k.persona}</span>
              {' . '}
              {k.origin === 'tapit' ? 'no local key material' : k.fingerprint}
              {' . '}
              {k.network}
            </div>
            {!backedUp && (
              <Link
                to="/keys"
                style={{ fontSize: 11, color: colors.orange, textDecoration: 'none' }}
              >
                Not backed up yet -- back up in Key Manager
              </Link>
            )}
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
        );
      })}
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
              [{k.persona}] {k.label} ({k.origin === 'tapit' ? 'Tapit' : k.fingerprint} . {k.network})
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
