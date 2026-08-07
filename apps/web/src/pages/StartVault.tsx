import { useNavigate } from 'react-router-dom';
import { colors, fonts, radii, space } from '../theme';
import { Button } from '../components/ui';
import type { VaultProposal } from '../lib/api';

// The coherent front door. A new person answers WHAT THEY WANT to do --
// plain outcomes, not a catalog of templates -- and we route them into the
// right builder with the matching shape pre-applied. The cryptography
// (keys, policy, compile) happens behind this, never in front of it.

interface Intent {
  emoji: string;
  title: string;
  desc: string;
  route: string;
  /** Template id to pre-apply on the policy builder. Omit to route as-is. */
  template?: string;
}

const INTENTS: Intent[] = [
  {
    emoji: '🛡️',
    title: 'Protect my own stack',
    desc: 'Just me. Keep my Bitcoin safe -- with a backup that recovers it if I ever lose a device.',
    route: '/policy',
    template: 'emergency-backup',
  },
  {
    emoji: '👨‍👩‍👧‍👦',
    title: 'Pass it to my kids',
    desc: 'I hold it now. Over time, my children can take it over on their own -- a vault that grows up with them.',
    route: '/policy',
    template: 'bloc',
  },
  {
    emoji: '🤝',
    title: 'A family we all manage',
    desc: 'A few of us share control. No one can move it alone, and everyone stays in the loop.',
    route: '/policy',
    template: 'family-inheritance',
  },
  {
    emoji: '🏢',
    title: 'A business holds it',
    desc: 'Company cold storage. Several signers; any few of them can authorize a spend.',
    route: '/policy',
    template: 'business-treasury',
  },
  {
    emoji: '🎁',
    title: 'A gift for someone, years from now',
    desc: "Lock it for a grandchild or anyone else until a future date. Nobody can touch it early except you and one independent person, together.",
    route: '/policy',
    template: 'gift-vault',
  },
];

export default function StartVault() {
  const navigate = useNavigate();

  function go(intent: Intent) {
    if (intent.template) {
      // All-zero numeric fields make the policy builder fall back to the
      // template's own sensible defaults; the user tunes from there.
      const prefill: VaultProposal = {
        template: intent.template,
        founder_quorum: 0,
        founder_count: 0,
        heir_quorum: 0,
        heir_count: 0,
        recovery_after_months: 0,
        inheritance_after_months: 0,
        summary: '',
      };
      navigate(intent.route, { state: { prefill } });
    } else {
      navigate(intent.route);
    }
  }

  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))',
          gap: 12,
        }}
      >
        {INTENTS.map(intent => (
          <button
            key={intent.title}
            type="button"
            onClick={() => go(intent)}
            style={{
              textAlign: 'left',
              cursor: 'pointer',
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              borderRadius: 14,
              padding: '18px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              fontFamily: fonts.sans,
              transition: 'border-color 120ms ease',
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = colors.gold)}
            onMouseLeave={e => (e.currentTarget.style.borderColor = colors.border)}
          >
            <div style={{ fontSize: 28, lineHeight: 1 }}>{intent.emoji}</div>
            <div style={{ fontSize: 17, fontWeight: 600, color: colors.text }}>{intent.title}</div>
            <div style={{ fontSize: 13, color: colors.muted, lineHeight: 1.5 }}>{intent.desc}</div>
          </button>
        ))}
      </div>

      <div
        style={{
          background: colors.input,
          border: `1px solid ${colors.gold}33`,
          borderRadius: radii.md,
          padding: '14px 18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ fontSize: 13, color: colors.sub, lineHeight: 1.5 }}>
          Not sure which fits? Sage walks you through it in plain language -- no Bitcoin knowledge needed.
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/assistant')}>
          Ask Sage
        </Button>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', paddingTop: space[1] }}>
        <button
          type="button"
          onClick={() => navigate('/vaults')}
          style={{ background: 'none', border: 'none', color: colors.muted, cursor: 'pointer', fontSize: 13, padding: 0 }}
        >
          I already have a vault
        </button>
        <span style={{ color: colors.border }}>|</span>
        <button
          type="button"
          onClick={() => navigate('/policy')}
          style={{ background: 'none', border: 'none', color: colors.muted, cursor: 'pointer', fontSize: 13, padding: 0 }}
        >
          Expert: open the full builder
        </button>
      </div>
    </div>
  );
}
