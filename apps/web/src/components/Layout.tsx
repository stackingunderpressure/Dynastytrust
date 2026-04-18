import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { APP_NAME, NAV_LINKS } from '../config';
import { colors, fonts, radii } from '../theme';

interface LayoutProps {
  activeNavId: string;
  onSignOut: () => void;
  children: ReactNode;
}

export function Layout({ activeNavId, onSignOut, children }: LayoutProps) {
  return (
    <div style={{ minHeight: '100vh', fontFamily: fonts.sans }}>
      <header className="dt-header">
        <span
          style={{
            fontFamily: fonts.display,
            fontSize: 17,
            fontWeight: 700,
            letterSpacing: '0.12em',
            color: colors.gold,
            whiteSpace: 'nowrap',
          }}
        >
          {APP_NAME}
        </span>
        <nav>
          {NAV_LINKS.map(link => {
            const active = link.id === activeNavId;
            return (
              <NavLink
                key={link.id}
                to={link.path}
                style={{
                  padding: '6px 14px',
                  borderRadius: radii.md,
                  fontSize: 14,
                  fontFamily: fonts.sans,
                  background: active ? colors.border : 'transparent',
                  color: active ? colors.text : colors.muted,
                  fontWeight: active ? 600 : 400,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {link.icon} {link.label}
              </NavLink>
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
      <main className="dt-page-main">{children}</main>
    </div>
  );
}
