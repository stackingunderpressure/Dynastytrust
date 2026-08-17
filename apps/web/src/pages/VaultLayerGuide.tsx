import { useNavigate, useParams, Navigate } from 'react-router-dom';
import { colors, fonts, radii, space } from '../theme';
import { Button, Card } from '../components/ui';
import { VAULT_LAYERS } from '../lib/vault-education';
import type { VaultProposal } from '../lib/api';

// One of the four fixed layer-concept pages replacing StartVault's old
// template cards (2026-08-17 front-door redesign) -- teaches the
// MECHANISM (what this layer does, the real trade-offs, a concrete
// illustration), not a template to pick. "Build it" hands off into the
// same VaultWizard builder every other path already uses.

export default function VaultLayerGuide() {
  const { layerId } = useParams<{ layerId: string }>();
  const navigate = useNavigate();
  const layer = VAULT_LAYERS.find(l => l.id === layerId);

  if (!layer) return <Navigate to="/start" replace />;

  function buildIt() {
    if (layer!.builderShape === 'leaves') {
      // Matches the shape StartVault's own "Build your own" card already
      // uses -- all-zero numeric fields signal the wizard to fall back to
      // its own sensible leaf-list defaults rather than a specific
      // template's config.
      const prefill: VaultProposal = {
        template: 'leaves',
        founder_quorum: 0, founder_count: 0, heir_quorum: 0, heir_count: 0,
        recovery_after_months: 0, inheritance_after_months: 0, summary: '',
      };
      navigate('/policy', { state: { prefill } });
    } else {
      // 'standard' is the wizard's own default shape -- no prefill needed.
      navigate('/policy');
    }
  }

  return (
    <div style={{ maxWidth: 700, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 13, color: colors.gold, fontWeight: 600, letterSpacing: '0.04em', marginBottom: 4 }}>
          {layer.tagline}
        </div>
        <p style={{ fontSize: 16, color: colors.text, lineHeight: 1.6 }}>{layer.explanation}</p>
      </div>

      <Card>
        <div style={{ fontSize: 15, fontWeight: 600, color: colors.text, marginBottom: 10 }}>The trade-offs</div>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {layer.tradeoffs.map((t, i) => (
            <li key={i} style={{ fontSize: 15, color: colors.text, lineHeight: 1.55 }}>{t}</li>
          ))}
        </ul>
      </Card>

      <Card>
        <div style={{ fontSize: 15, fontWeight: 600, color: colors.text, marginBottom: 10 }}>{layer.illustration.title}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {layer.illustration.lines.map((line, i) => (
            <div
              key={i}
              style={{
                fontSize: 15, color: colors.text, lineHeight: 1.5,
                padding: '10px 12px', background: colors.input, borderRadius: radii.sm,
              }}
            >
              {line}
            </div>
          ))}
        </div>
      </Card>

      {layer.howToCraft && (
        <div
          style={{
            background: colors.input, border: `1px solid ${colors.gold}33`, borderRadius: radii.md,
            padding: '12px 16px', fontSize: 15, color: colors.text, lineHeight: 1.55,
          }}
        >
          {layer.howToCraft}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', paddingTop: space[2] }}>
        <Button onClick={buildIt}>Build it</Button>
        <button
          type="button"
          onClick={() => navigate('/start')}
          style={{ background: 'none', border: 'none', color: colors.muted, cursor: 'pointer', fontSize: 13, padding: 0, fontFamily: fonts.sans }}
        >
          Back to all paths
        </button>
      </div>
    </div>
  );
}
