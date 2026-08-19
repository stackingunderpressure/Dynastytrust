import { useNavigate, useParams, Navigate } from 'react-router-dom';
import { colors, fonts, radii, space } from '../theme';
import { Button, Card } from '../components/ui';
import { VAULT_LAYERS } from '../lib/vault-education';

// One of the four fixed layer-concept pages replacing StartVault's old
// template cards (2026-08-17 front-door redesign) -- teaches the
// MECHANISM (what this layer does, the real trade-offs, a concrete
// illustration), not a template to pick. "Build it" hands off into the
// same unified VaultWizard builder every path leads to now (2026-08-19
// redesign) -- the wizard always opens blank on its own leaf-list builder
// regardless of which layer sent the reader here, so there is no prefill
// left to compute.

export default function VaultLayerGuide() {
  const { layerId } = useParams<{ layerId: string }>();
  const navigate = useNavigate();
  const layer = VAULT_LAYERS.find(l => l.id === layerId);

  if (!layer) return <Navigate to="/start" replace />;

  return (
    <div style={{ maxWidth: 700, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 13, color: colors.gold, fontWeight: 600, letterSpacing: '0.04em', marginBottom: 4 }}>
          {layer.tagline}
        </div>
        <p style={{ fontSize: 18, fontWeight: 450, color: colors.text, lineHeight: 1.6 }}>{layer.explanation}</p>
      </div>

      <Card>
        <div style={{ fontSize: 16, fontWeight: 600, color: colors.text, marginBottom: 10 }}>The trade-offs</div>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {layer.tradeoffs.map((t, i) => (
            <li key={i} style={{ fontSize: 17, fontWeight: 450, color: colors.text, lineHeight: 1.55 }}>{t}</li>
          ))}
        </ul>
      </Card>

      <Card>
        <div style={{ fontSize: 16, fontWeight: 600, color: colors.text, marginBottom: 10 }}>{layer.illustration.title}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {layer.illustration.lines.map((line, i) => (
            <div
              key={i}
              style={{
                fontSize: 17, fontWeight: 450, color: colors.text, lineHeight: 1.5,
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
            padding: '12px 16px', fontSize: 16, fontWeight: 450, color: colors.text, lineHeight: 1.55,
          }}
        >
          {layer.howToCraft}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', paddingTop: space[2] }}>
        <Button onClick={() => navigate('/policy')}>Build it</Button>
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
