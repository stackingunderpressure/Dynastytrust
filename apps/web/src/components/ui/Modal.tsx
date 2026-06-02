import type { ReactNode } from 'react';
import { colors, fonts, space } from '../../theme';

// Shared modal shell. Matches the pattern previously inlined per-page so the
// whole app gets one overlay / panel treatment. Click the backdrop or the x
// to close.
export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.78)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
        padding: space[4],
      }}
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          padding: '28px 32px',
          width: '100%',
          maxWidth: wide ? 660 : 520,
          maxHeight: '92vh',
          overflowY: 'auto',
          fontFamily: fonts.sans,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 20,
          }}
        >
          <h2
            style={{
              fontSize: 20,
              fontWeight: 600,
              color: colors.text,
              fontFamily: fonts.display,
              margin: 0,
            }}
          >
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              color: colors.muted,
              fontSize: 18,
              cursor: 'pointer',
            }}
          >
            x
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
