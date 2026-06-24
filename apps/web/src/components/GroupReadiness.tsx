import { useEffect, useState, type CSSProperties } from 'react';
import { api, type ReadinessState, type MemberReadiness } from '../lib/api';
import { Button, Input } from './ui';
import { useToast } from './toast';
import { colors, fonts, radii, space } from '../theme';

/**
 * GroupReadiness -- the peer flag/clear board.
 *
 * Lets a member raise a red flag on a co-member's wallet (a heads-up the whole
 * group sees, with a reason) or clear one. Guidance only: flagging never locks
 * anyone out or touches their spend -- it makes a possible compromise visible
 * and points the flagged member at the sweep. Renders nothing when the user has
 * no co-members (solo), or the read fails.
 */
export function GroupReadiness() {
  const toast = useToast();
  const [state, setState] = useState<ReadinessState | null>(null);
  const [flagging, setFlagging] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setState(await api.readiness.get());
    } catch {
      // Readiness is advisory -- never break the page on a failed read.
    }
  }
  useEffect(() => { void load(); }, []);

  if (!state || state.peers.length === 0) return null;

  // One row per co-member (a person can share more than one vault). Readiness
  // is global, so flagging in any shared vault is enough.
  const seen = new Set<string>();
  const peers = state.peers.filter((p) => {
    if (seen.has(p.user_id)) return false;
    seen.add(p.user_id);
    return true;
  });

  async function act(peer: MemberReadiness, kind: 'flag' | 'clear') {
    setBusy(true);
    try {
      await api.readiness.flag({
        subject_user_id: peer.user_id,
        vault_id: peer.vault_id,
        kind,
        reason: kind === 'flag' ? reason.trim() || undefined : undefined,
      });
      toast.success(
        kind === 'flag'
          ? 'Flagged. Your whole group can see it -- they can sweep to a clean wallet.'
          : 'Flag cleared. Back to green.',
      );
      setFlagging(null);
      setReason('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update readiness');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.wrap}>
      <h3 style={s.title}>Group readiness</h3>
      <p style={s.intro}>
        Green means ready. If you believe a co-member's wallet is compromised,
        flag it -- a heads-up the whole group sees. Flagging never locks anyone
        out or touches their Bitcoin; it points them to sweep to a clean wallet.
      </p>

      <div style={s.list}>
        {peers.map((peer) => {
          const red = peer.readiness === 'red';
          const name = peer.label || `member ${peer.user_id.slice(0, 8)}`;
          return (
            <div key={peer.user_id} style={s.rowWrap}>
              <div style={s.row}>
                <span style={{ ...s.dot, background: red ? colors.red : colors.green }} />
                <span style={s.name}>{name}</span>
                <span style={{ ...s.status, color: red ? colors.red : colors.green }}>
                  {peer.linked ? (red ? 'flagged' : 'green') : 'no wallet linked'}
                </span>
                {red ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void act(peer, 'clear')}
                  >
                    Clear flag
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || flagging === peer.user_id}
                    onClick={() => { setFlagging(peer.user_id); setReason(''); }}
                  >
                    Flag
                  </Button>
                )}
              </div>

              {flagging === peer.user_id && (
                <div style={s.flagBox}>
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why? (e.g. lost phone, suspicious login)"
                    style={{ fontSize: 14 }}
                  />
                  <div style={s.flagActions}>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => void act(peer, 'flag')}
                    >
                      Confirm flag
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => { setFlagging(null); setReason(''); }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: radii.lg,
    padding: '18px 22px',
    fontFamily: fonts.sans,
  },
  title: { margin: 0, fontSize: 15, fontWeight: 700, color: colors.text },
  intro: { margin: `${space[2]}px 0 ${space[4]}px`, fontSize: 13.5, lineHeight: 1.6, color: colors.sub },
  list: { display: 'flex', flexDirection: 'column', gap: space[2] },
  rowWrap: { borderTop: `1px solid ${colors.border}`, paddingTop: space[3] },
  row: { display: 'flex', alignItems: 'center', gap: space[3] },
  dot: { width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto' },
  name: { fontSize: 14, color: colors.text, fontWeight: 500 },
  status: { fontSize: 12, marginLeft: 2, marginRight: 'auto' },
  flagBox: { display: 'flex', flexDirection: 'column', gap: space[2], marginTop: space[3] },
  flagActions: { display: 'flex', gap: space[2] },
};
