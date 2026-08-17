import { useNavigate } from 'react-router-dom';
import { colors, fonts, radii, space } from '../theme';
import { Button } from '../components/ui';
import { VAULT_LAYERS } from '../lib/vault-education';

// The front door (2026-08-17 redesign, operator: "it's everywhere right
// now all pointing to the same builder compiler... too confusing to
// normie"). Previously seven template cards, each one tap straight into
// the compiler with zero explanation. Now: a small, fixed set of layer
// concepts -- the pieces every vault is actually assembled from -- each
// its own page teaching why you'd want it and the real trade-offs, before
// "Build it" hands off into the same builder every path already used.
// The builder is the centerpiece; these pages are the on-ramp, not
// another catalog to read through (docs/ux-coherence-redesign.md section
// 3's actual target was 15 named templates -- this is 4 fixed concept
// pages teaching the mechanism, a different thing that doc didn't
// anticipate; see its front-door-redesign amendment).

export default function StartVault() {
  const navigate = useNavigate();

  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <p style={{ fontSize: 16, fontWeight: 450, color: colors.text, lineHeight: 1.6, margin: 0 }}>
        Every vault is built from a few pieces you choose -- learn each one, then build the vault that's
        actually yours. Start wherever you want; nothing forces you through all four before you can build.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))',
          gap: 12,
        }}
      >
        {VAULT_LAYERS.map((layer, i) => (
          <button
            key={layer.id}
            type="button"
            onClick={() => navigate(`/start/${layer.id}`)}
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
            <div style={{ fontSize: 11, fontWeight: 700, color: colors.gold, letterSpacing: '0.06em' }}>
              {i + 1}. {layer.title.toUpperCase()}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, color: colors.text }}>{layer.tagline}</div>
            <div style={{ fontSize: 15, fontWeight: 450, color: colors.text, lineHeight: 1.5 }}>{layer.explanation}</div>
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
          Not sure where to start? Sage walks you through it in plain language -- no Bitcoin knowledge needed.
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
