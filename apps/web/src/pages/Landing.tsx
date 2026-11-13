import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { APP_NAME } from '../config';
import { colors, fonts, radii, space } from '../theme';
import { Button } from '../components/ui';
import { LoadingScreen } from '../components/LoadingScreen';

/**
 * Landing.tsx -- public first-lander page.
 *
 * Behavior:
 *   - If the caller already has a Supabase session, redirect to
 *     /vaults. Repeat users never see this page again until they
 *     explicitly sign out.
 *   - First-time visitors see the mission, the primitive, and an
 *     inline sign-in / sign-up form. Everything above the fold on
 *     desktop; stacked on mobile.
 *   - Further detail is scrollable below the fold for visitors who
 *     want to read before signing up.
 */

export default function Landing() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);

  // Session check -- return an authed session straight to the app.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate('/vaults', { replace: true });
      else setChecking(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      if (s) navigate('/vaults', { replace: true });
    });
    return () => subscription.unsubscribe();
  }, [navigate]);

  if (checking) return <LoadingScreen />;

  return (
    <div style={s.page}>
      <Hero />
      <Pillars />
      <Modes />
      <Footer />
    </div>
  );
}

// // -- Hero with inline auth form

function Hero() {
  return (
    <div style={s.hero}>
      <div style={s.heroInner}>
        <div style={s.heroLeft}>
          <div style={s.logo}>{APP_NAME}</div>
          <h1 style={s.title}>
            Bitcoin vaults that outlive you.
          </h1>
          <p style={s.tagline}>
            Taproot multisig with inheritance, recovery, and governance
            compiled into the script. Your keys, your coins, your rules
            for the next 50 years. No custodian, no admin, no one who
            can undo what you set up.
          </p>

          <ul style={s.bullets}>
            <Bullet>
              Three spending paths in one address: founders now,
              timelocked recovery, timelocked inheritance.
            </Bullet>
            <Bullet>
              Keys never leave your browser or hardware wallet. The
              server never had them and cannot move your coins.
            </Bullet>
            <Bullet>
              Attorney-grade audit PDF + a standard, exportable descriptor.
              The vault works even if DynastyTrust vanishes.
            </Bullet>
            <Bullet>
              Two modes: hosted for families that want support, or
              sovereign binary for users who run everything local.
            </Bullet>
          </ul>
        </div>

        <div style={s.heroRight}>
          <InlineAuthForm />
        </div>
      </div>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li style={s.bullet}>
      <span style={s.bulletMark}>+</span>
      <span>{children}</span>
    </li>
  );
}

// // -- Inline auth form
// Same supabase calls as the standalone Auth page, compressed into
// a card that lives on the landing.

// One sign-in screen for the whole app (pages/Auth.tsx, which RequireAuth
// shows). This card used to carry its own email-only form, so it never
// offered a username or Tapit and told people their email was how they
// sign back in (operator, 2026-11-13: make sure nothing still describes
// the old way in). It now names the three ways in and opens that screen.
function InlineAuthForm() {
  const navigate = useNavigate();
  const line: CSSProperties = { margin: 0, fontSize: 17, lineHeight: 1.55, color: colors.sub };
  return (
    <div style={s.authCard}>
      <div style={s.authHeading}>Sign in or create an account</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: space[2], marginBottom: space[3] }}>
        <p style={line}><strong style={{ color: colors.text }}>Email and password.</strong> Recommended: if you are ever locked out, a code to your email gets you back in.</p>
        <p style={line}><strong style={{ color: colors.text }}>Username and password.</strong> No email at all, so no reset: keep the password safe, and turn on Face ID after.</p>
        <p style={line}><strong style={{ color: colors.text }}>Sovereign sign-in with Tapit.</strong> Your own Tapit wallet proves it is you. No email, no password here.</p>
      </div>
      <Button style={{ width: '100%', padding: '14px', fontSize: 17 }} onClick={() => navigate('/vaults')}>
        Continue
      </Button>
      <p style={s.authFine}>
        No KYC. No credit card. Private keys are made on your own device and never touch our servers.
      </p>
    </div>
  );
}

// // -- Pillars (what you get)

function Pillars() {
  const items = [
    {
      title: 'Three-path Taproot vault',
      body: 'A single Taproot output with three spending leaves. Founders spend now with a quorum. A recovery quorum spends after a timelock. Heirs spend unilaterally after a longer timelock. Absolute CLTV, so inheritance horizons of 25 years are native -- no BIP 68 ceiling.',
    },
    {
      title: 'Trust layer that Bitcoin cannot see',
      body: 'Every member Schnorr-signs the hash of the trust doc. Founders sign periodic proof-of-life. Witnesses sign death declarations. The chain enforces the script; the attestation layer enforces the story. Both export to a court-admissible PDF.',
    },
    {
      title: 'Role-aware governance',
      body: 'Trustees see the signing queue. Beneficiaries see their distributions and timelock countdowns. Successors see time-to-inheritance. One vault, several views -- the same way a real trust works.',
    },
    {
      title: 'Built for exit',
      body: 'Every vault auto-generates a plaintext backup and a standard descriptor QR. If this app disappears tomorrow, the coins still spend from any miniscript-aware wallet with just your descriptor and one seed phrase. You are never locked in.',
    },
  ];
  return (
    <section style={s.section}>
      <SectionHeading eyebrow="What you get" title="A real trust, encoded on Bitcoin." />
      <div style={s.pillarGrid}>
        {items.map(p => (
          <div key={p.title} style={s.pillar}>
            <div style={s.pillarTitle}>{p.title}</div>
            <p style={s.pillarBody}>{p.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// // -- Two modes (hosted vs sovereign)

function Modes() {
  return (
    <section style={s.section}>
      <SectionHeading eyebrow="Two modes" title="Pick the trust model that fits." />
      <div style={s.modesGrid}>
        <div style={{ ...s.mode, borderTop: `3px solid ${colors.gold}` }}>
          <div style={s.modeLabel}>Hosted</div>
          <div style={s.modeTitle}>DynastyTrust for families</div>
          <p style={s.modeBody}>
            Sign up, click through the Policy Builder, have a working
            multisig family trust in 20 minutes. Optional legal wrapper
            through partner firms (Wyoming Statutory, Nevada DAPT,
            Cayman STAR). Support that responds. We coordinate; Bitcoin
            still enforces.
          </p>
          <ul style={s.modeList}>
            <ModeBullet>Sign in with email, a username, or your own Tapit wallet</ModeBullet>
            <ModeBullet>Attorney PDF export included</ModeBullet>
            <ModeBullet>Realtime governance across family members</ModeBullet>
            <ModeBullet>Optional stipend + distribution-wallet automation</ModeBullet>
          </ul>
        </div>
        <div style={{ ...s.mode, borderTop: `3px solid ${colors.green}` }}>
          <div style={{ ...s.modeLabel, color: colors.green }}>Sovereign</div>
          <div style={s.modeTitle}>Download, run isolated</div>
          <p style={s.modeBody}>
            One binary. Local SQLite. Local policy compiler. Your own
            Tapit wallet is your identity -- no email, no account, no
            server that can be subpoenaed. Tor by default. Nostr relays for peer
            sync. Source-available and self-hostable. For users who
            treat sovereignty as a hard requirement.
          </p>
          <ul style={s.modeList}>
            <ModeBullet>No account and no server-side identity: your Tapit wallet is you</ModeBullet>
            <ModeBullet>Connect to your own Bitcoin node</ModeBullet>
            <ModeBullet>Peer-to-peer vault coordination over Tor</ModeBullet>
            <ModeBullet>Signed releases, IPFS-pinned</ModeBullet>
          </ul>
          <div style={s.modeFine}>Sovereign binary ships after cloud build hardens. Design: docs/super-sovereign-mode.md</div>
        </div>
      </div>
    </section>
  );
}

function ModeBullet({ children }: { children: React.ReactNode }) {
  return (
    <li style={s.modeItem}>
      <span style={s.modeMark}>-</span>
      <span>{children}</span>
    </li>
  );
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div style={s.sectionHead}>
      <div style={s.eyebrow}>{eyebrow}</div>
      <h2 style={s.sectionTitle}>{title}</h2>
    </div>
  );
}

function Footer() {
  return (
    <footer style={s.footer}>
      <div style={s.footerInner}>
        <div style={s.footerLeft}>
          <div style={s.footerLogo}>{APP_NAME}</div>
          <div style={s.footerTagline}>
            Not your keys, not your coins. And now, not your trustees'
            problem either.
          </div>
        </div>
        <div style={s.footerRight}>
          <a href="/docs/manifesto.md" style={s.footerLink}>Manifesto</a>
          <a href="https://github.com/stackingunderpressure/dynastytrust" style={s.footerLink} target="_blank" rel="noreferrer">
            Source
          </a>
        </div>
      </div>
    </footer>
  );
}

// // -- Styles

const s: Record<string, CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: colors.bg,
    color: colors.text,
    fontFamily: fonts.sans,
  },

  hero: {
    paddingTop: 64,
    paddingBottom: 80,
    paddingLeft: space[6],
    paddingRight: space[6],
    maxWidth: 1200,
    margin: '0 auto',
  },
  heroInner: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 48,
    alignItems: 'flex-start',
  },
  heroLeft: { flex: '2 1 420px', minWidth: 0 },
  heroRight: { flex: '1 1 320px', minWidth: 0, maxWidth: 440 },

  logo: {
    fontFamily: fonts.display,
    fontSize: 17,
    fontWeight: 700,
    letterSpacing: '0.18em',
    color: colors.gold,
    textTransform: 'uppercase',
    marginBottom: space[5],
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 54,
    lineHeight: 1.05,
    fontWeight: 700,
    color: colors.text,
    marginTop: 0,
    marginBottom: space[5],
    letterSpacing: '-0.01em',
  },
  tagline: {
    fontSize: 18,
    lineHeight: 1.6,
    color: colors.sub,
    marginBottom: space[6],
    maxWidth: 580,
  },

  bullets: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
  },
  bullet: {
    display: 'flex',
    gap: space[3],
    alignItems: 'flex-start',
    fontSize: 17,
    lineHeight: 1.55,
    color: colors.text,
  },
  bulletMark: {
    color: colors.gold,
    fontFamily: fonts.mono,
    fontSize: 17,
    flex: '0 0 auto',
    marginTop: 1,
  },

  authCard: {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: 14,
    padding: '28px 28px 22px',
  },
  tabs: {
    display: 'flex',
    gap: 4,
    background: colors.input,
    borderRadius: 10,
    padding: 4,
    marginBottom: space[5],
  },
  tab: {
    flex: 1,
    padding: '8px 0',
    border: 'none',
    borderRadius: radii.md,
    background: 'transparent',
    color: colors.muted,
    fontSize: 17,
    fontFamily: fonts.sans,
    cursor: 'pointer',
  },
  tabActive: {
    background: colors.border,
    color: colors.text,
  },
  authForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  fieldLabel: {
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: '0.08em',
    color: colors.sub,
    textTransform: 'uppercase',
    marginTop: space[2],
  },
  authError: {
    fontSize: 16,
    color: colors.red,
    margin: '6px 0 0',
  },
  authFine: {
    fontSize: 15,
    color: colors.muted,
    lineHeight: 1.55,
    marginTop: space[4],
    marginBottom: 0,
  },
  authHeading: {
    fontSize: 18,
    fontWeight: 600,
    color: colors.text,
    marginBottom: space[2],
  },
  authSub: {
    fontSize: 17,
    color: colors.sub,
    lineHeight: 1.6,
    marginBottom: space[4],
  },
  linkBtn: {
    background: 'none',
    border: 'none',
    color: colors.gold,
    fontSize: 17,
    cursor: 'pointer',
    padding: 0,
    fontFamily: fonts.sans,
  },

  section: {
    maxWidth: 1100,
    margin: '0 auto',
    padding: `48px ${space[6]}px 64px`,
    borderTop: `1px solid ${colors.border}`,
  },
  sectionHead: { marginBottom: space[8] },
  eyebrow: {
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '0.18em',
    color: colors.gold,
    textTransform: 'uppercase',
    marginBottom: space[2],
  },
  sectionTitle: {
    fontFamily: fonts.display,
    fontSize: 34,
    fontWeight: 700,
    color: colors.text,
    margin: 0,
    lineHeight: 1.15,
  },
  pillarGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
    gap: space[5],
  },
  pillar: {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    padding: '22px 22px',
  },
  pillarTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: colors.gold,
    marginBottom: space[2],
  },
  pillarBody: {
    fontSize: 15,
    lineHeight: 1.6,
    color: colors.sub,
    margin: 0,
  },

  modesGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
    gap: space[5],
  },
  mode: {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    padding: '24px 24px',
  },
  modeLabel: {
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: colors.gold,
    marginBottom: space[2],
  },
  modeTitle: {
    fontFamily: fonts.display,
    fontSize: 22,
    fontWeight: 700,
    color: colors.text,
    marginBottom: space[3],
  },
  modeBody: {
    fontSize: 17,
    lineHeight: 1.55,
    color: colors.sub,
    marginBottom: space[4],
  },
  modeList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  modeItem: {
    display: 'flex',
    gap: space[2],
    alignItems: 'flex-start',
    fontSize: 17,
    lineHeight: 1.5,
    color: colors.text,
  },
  modeMark: {
    color: colors.muted,
    fontFamily: fonts.mono,
    flex: '0 0 auto',
    marginTop: 2,
  },
  modeFine: {
    marginTop: space[4],
    fontSize: 15,
    color: colors.muted,
    fontFamily: fonts.mono,
  },

  footer: {
    borderTop: `1px solid ${colors.border}`,
    padding: `28px ${space[6]}px`,
    marginTop: 32,
    background: colors.header,
  },
  footerInner: {
    maxWidth: 1100,
    margin: '0 auto',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space[4],
    flexWrap: 'wrap',
  },
  footerLeft: {},
  footerLogo: {
    fontFamily: fonts.display,
    fontSize: 17,
    fontWeight: 700,
    letterSpacing: '0.18em',
    color: colors.gold,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  footerTagline: {
    fontSize: 16,
    color: colors.muted,
  },
  footerRight: {
    display: 'flex',
    gap: space[5],
  },
  footerLink: {
    fontSize: 17,
    color: colors.sub,
    textDecoration: 'none',
  },
};
