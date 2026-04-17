import type { ReactNode } from 'react';
import { APP_NAME, NAV_LINKS } from '../config';
import { colors, fonts, radii, space } from '../theme';

interface LayoutProps {
  activeNavId: string;
  onNavigate: (id: string) => void;
  onSignOut: () => void;
  children: ReactNode;
}

export function Layout({ activeNavId, onNavigate, onSignOut, children }: LayoutProps) {
  return (
    <div style={{ minHeight: '100vh', fontFamily: fonts.sans }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `0 ${space[8]}px`,
          height: 60,
          borderBottom: `1px solid ${colors.border}`,
          background: colors.header,
          position: 'sticky',
          top: 0,
          zIndex: 100,
        }}
      >
        <span
          style={{
            fontFamily: fonts.display,
            fontSize: 17,
            fontWeight: 700,
            letterSpacing: '0.12em',
            color: colors.gold,
          }}
        >
          {APP_NAME}
        </span>
        <nav style={{ display: 'flex', gap: 2 }}>
          {NAV_LINKS.map(link => {
            const active = link.id === activeNavId;
            return (
              <button
                key={link.id}
                onClick={() => onNavigate(link.id)}
                style={{
                  padding: '6px 18px',
                  border: 'none',
                  borderRadius: radii.md,
                  fontSize: 14,
                  cursor: 'pointer',
                  fontFamily: fonts.sans,
                  background: active ? colors.border : 'transparent',
                  color: active ? colors.text : colors.muted,
                  fontWeight: active ? 600 : 400,
                }}
              >
                {link.icon} {link.label}
              </button>
            );
          })}
        </nav>
        <button
          onClick={onSignOut}
          style={{
            background: 'none',
            border: `1px solid ${colors.border}`,
            borderRadius: radii.md,
            color: colors.muted,
            fontSize: 13,
            padding: '6px 14px',
            cursor: 'pointer',
            fontFamily: fonts.sans,
          }}
        >
          Sign out
        </button>
      </header>
      <main style={{ maxWidth: 1000, margin: '0 auto', padding: `${space[8]}px ${space[8]}px` }}>
        {children}
      </main>
    </div>
  );
}
