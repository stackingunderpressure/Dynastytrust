import { useEffect, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { APP_NAME, NAV_LINKS } from '../config';
import { supabase } from '../lib/supabase';
import { colors, fonts, radii } from '../theme';
import { useReminderCount } from './RemindersBanner';

interface LayoutProps {
  activeNavId: string;
  onSignOut: () => void;
  children: ReactNode;
}

export function Layout({ activeNavId, onSignOut, children }: LayoutProps) {
  const reminderCount = useReminderCount();
  // Pull the signed-in user's email once and derive a friendly name
  // (local part before @). Supabase's onAuthStateChange keeps it
  // fresh across sign-in / sign-out in the same tab.
  const [displayName, setDisplayName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const nameFromEmail = (email: string | undefined | null): string | null => {
      if (!email) return null;
      const local = email.split('@')[0];
      // Replace common separators so "jane.doe" shows as "jane doe",
      // then keep it lowercase -- users can't set a display name yet.
      return local.replace(/[._-]+/g, ' ');
    };
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setDisplayName(nameFromEmail(data.session?.user?.email));
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      if (!cancelled) setDisplayName(nameFromEmail(s?.user?.email));
    });
    return () => { cancelled = true; subscription.unsubscribe(); };
  }, []);

  return (
    <div style={{ minHeight: '100vh', fontFamily: fonts.sans }}>
      <header className="dt-shell-header">
        <div className="dt-header-top">
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
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              minWidth: 0,
              flex: '1 1 auto',
              justifyContent: 'flex-end',
            }}
          >
            {displayName && (
              <span
                title={displayName}
                style={{
                  fontSize: 13,
                  color: colors.sub,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: 220,
                }}
              >
                Hi, <span style={{ color: colors.text }}>{displayName}</span>
              </span>
            )}
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
          </div>
        </div>
        <nav className="dt-header-nav">
          {NAV_LINKS.map(link => {
            const active = link.id === activeNavId;
            const badge = link.id === 'reminders' && reminderCount > 0 ? reminderCount : null;
            return (
              <NavLink
                key={link.id}
                to={link.path}
                style={{
                  padding: '8px 14px',
                  borderRadius: radii.md,
                  fontSize: 14,
                  fontFamily: fonts.sans,
                  background: active ? colors.border : 'transparent',
                  color: active ? colors.text : colors.muted,
                  fontWeight: active ? 600 : 400,
                  textDecoration: 'none',
                  textAlign: 'center',
                }}
              >
                {link.icon} {link.label}
                {badge != null && (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 11,
                      fontWeight: 700,
                      background: colors.orange,
                      color: colors.bg,
                      borderRadius: 9,
                      padding: '1px 7px',
                    }}
                  >
                    {badge}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>
      </header>
      <main className="dt-page-main">{children}</main>
    </div>
  );
}
