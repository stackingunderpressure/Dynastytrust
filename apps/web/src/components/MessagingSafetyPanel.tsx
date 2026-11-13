import { useState } from 'react';
import type { VaultMember } from '../lib/api';
import { getMessagingPubkey } from '../lib/messaging';
import { markPeerKeyCompared, safetyCode, type PeerKeyStatus } from '../lib/messaging-safety';
import { colors, fonts, radii } from '../theme';
import { Button } from './ui';

export interface PeerKey { member: VaultMember; pubkey: string; status: PeerKeyStatus }

/**
 * Threat model item E: the safety code for each other member, compared by
 * voice, and a stop on any member whose messaging key changed (see
 * lib/messaging-safety.ts). Messages to a member whose key changed are
 * paused by the caller until the new code is compared here.
 */
export function MessagingSafetyPanel({ vaultId, peers, onChanged }: { vaultId: string; peers: PeerKey[]; onChanged: () => void }) {
  const changed = peers.filter(p => p.status === 'changed');
  const [open, setOpen] = useState(false);
  if (peers.length === 0) return null;
  const mine = getMessagingPubkey();
  const showList = open || changed.length > 0;
  const notCompared = peers.filter(p => p.status === 'not_compared').length;

  return (
    <div style={{
      padding: '10px 12px', borderRadius: radii.sm, display: 'flex', flexDirection: 'column', gap: 10,
      background: changed.length ? colors.dangerBg : colors.surface,
      border: `1px solid ${changed.length ? colors.borderDanger : colors.border}`,
    }}>
      {changed.length > 0 ? (
        <div style={{ fontSize: 17, color: colors.text, lineHeight: 1.5 }}>
          <strong style={{ color: colors.red }}>
            {changed.map(p => p.member.label || 'A member').join(', ')} {changed.length === 1 ? 'has' : 'have'} a different messaging key than this phone saw before.
          </strong>{' '}
          Nothing more is sent to {changed.length === 1 ? 'them' : 'these people'} until you check. It may be honest -- a new phone, or a
          new key -- or someone may have swapped it to read your messages. Call them, by voice, and read each other the code
          below. Accept only if both phones show the same code.
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 16, color: colors.sub, lineHeight: 1.5 }}>
            {notCompared === 0
              ? 'You have compared safety codes with everyone here.'
              : `Make sure messages reach the right people: compare a safety code with ${notCompared === 1 ? 'one person' : `${notCompared} people`} by voice.`}
          </div>
          <Button variant="ghost" size="sm" type="button" style={{ minHeight: 44, fontSize: 15 }} onClick={() => setOpen(o => !o)}>
            {open ? 'Hide safety codes' : 'Safety codes'}
          </Button>
        </div>
      )}

      {showList && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!changed.length && (
            <div style={{ fontSize: 15, color: colors.sub, lineHeight: 1.5 }}>
              Call the person, or ask in person, and read the code aloud. Their phone shows the same code for you only if
              nobody has swapped a key in between. Never compare it by text or email: whoever swapped the key could answer.
            </div>
          )}
          {peers.map(p => (
            <div key={p.member.id} style={{ background: colors.inset, borderRadius: radii.md, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 17, color: colors.text }}>
                <strong>{p.member.label || '(unnamed member)'}</strong>
                <span style={{ marginLeft: 8, fontSize: 15, color: p.status === 'changed' ? colors.red : p.status === 'compared' ? colors.green : colors.muted }}>
                  {p.status === 'changed' ? 'key changed -- check before sending' : p.status === 'compared' ? 'compared by voice' : 'not compared yet'}
                </span>
              </div>
              <div style={{ fontFamily: fonts.mono, fontSize: 22, letterSpacing: '0.08em', color: colors.gold }}>
                {safetyCode(mine, p.pubkey)}
              </div>
              {p.status !== 'compared' && (
                <Button
                  size="sm"
                  type="button"
                  variant={p.status === 'changed' ? 'danger' : 'primary'}
                  style={{ minHeight: 44, alignSelf: 'flex-start', fontSize: 15 }}
                  onClick={() => { markPeerKeyCompared(vaultId, p.member.user_id, p.pubkey); onChanged(); }}
                >
                  {p.status === 'changed' ? 'Their phone shows this code -- accept the new key' : 'Their phone shows this code'}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
