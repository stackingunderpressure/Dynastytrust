import { useEffect, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { APP_NAME, NAV_LINKS } from '../config';
import { supabase } from '../lib/supabase';
import { accountName } from '../lib/account-name';
import { DOWNLOAD } from '../lib/download';
import { FaceIdSignInOffer } from './FaceIdSignIn';
import { colors, fonts, radii } from '../theme';
import { useReminderCount } from './RemindersBanner';
import { VersionBadge } from './VersionBadge';

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
    // The name chosen at key sign-up, else the email's first part with
    // separators as spaces ("jane.doe" -> "jane doe"). A key account's
    // placeholder address is never shown (lib/account-name.ts).
    const nameOf = (user: Parameters<typeof accountName>[0]): string | null => {
      const n = accountName(user);
      return n ? n.replace(/[._-]+/g, ' ') : null;
    };
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setDisplayName(nameOf(data.session?.user));
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      if (!cancelled) setDisplayName(nameOf(s?.user));
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
              fontSize: 18,
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
                  fontSize: 17,
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
            <VersionBadge />
            {/* The download has no account to sign out of. */}
            {!DOWNLOAD && <button
              onClick={onSignOut}
              style={{
                background: 'none',
                border: `1px solid ${colors.border}`,
                borderRadius: radii.md,
                color: colors.muted,
                fontSize: 17,
                padding: '6px 14px',
                cursor: 'pointer',
                fontFamily: fonts.sans,
              }}
            >
              Sign out
            </button>}
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
                  fontSize: 17,
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
                      fontSize: 15,
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
      <main className="dt-page-main"><FaceIdSignInOffer />{children}</main>
    </div>
  );
}
