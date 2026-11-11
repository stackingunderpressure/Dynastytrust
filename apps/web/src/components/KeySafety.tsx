import { useState } from 'react';
import { KEY_LESSONS } from '../lib/key-education';
import { colors, radii, space } from '../theme';

// "What makes a key safe" -- the short lesson shown wherever a key is
// made. Closed by default so it never stands between a person and the
// form, open in one tap. Content lives in lib/key-education.ts.
export function KeySafety({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: radii.md, background: colors.inset }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: space[2], width: '100%', minHeight: 44,
          padding: `${space[2]}px ${space[3]}px`, background: 'transparent', border: 'none', color: colors.gold,
          font: 'inherit', fontSize: 15, fontWeight: 600, textAlign: 'left', cursor: 'pointer',
        }}
      >
        <span>What makes a key safe</span>
        <span style={{ color: colors.sub, fontWeight: 400 }}>{open ? 'Hide' : 'Read'}</span>
      </button>
      {open && (
        <div style={{ padding: `0 ${space[3]}px ${space[3]}px` }}>
          {KEY_LESSONS.map(l => (
            <div key={l.title} style={{ marginTop: space[3] }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: colors.text, marginBottom: 2 }}>{l.title}</div>
              <div style={{ fontSize: 14, color: colors.sub, lineHeight: 1.6 }}>{l.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
