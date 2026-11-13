import { whoSignsWords } from '../lib/path-words';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Vault, type VaultInvite, type VaultMember } from '../lib/api';
import { supabase } from '../lib/supabase';
import { durationWords } from '../lib/timelock-words';
import { colors, fonts, space } from '../theme';
import { Button, Card } from './ui';

// A path-builder vault that is still being set up (journey gap J3).
//
// The older draft card counted "planned founders" and offered a Compile
// button; for this vault shape those counts are zero, so it read
// "Ready to compile / 0 of 0 members joined" with a button that failed.
// This card shows the owner how far along the slots are and who is
// still to join or be confirmed, and shows an invited person only what
// is theirs: their path, their key's fingerprint, and whether the owner
// has confirmed it yet.

export function PathDraftCard({ vault }: { vault: Vault }) {
  const navigate = useNavigate();
  const [me, setMe] = useState<string | null>(null);
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [invites, setInvites] = useState<VaultInvite[]>([]);

  const isOwner = me != null && me === vault.user_id;
  const load = useCallback(async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user.id ?? null;
      setMe(uid);
      setMembers((await api.members.list(vault.id)).members);
      if (uid === vault.user_id) setInvites((await api.invites.list(vault.id)).invites);
    } catch {
      /* the card still renders what it has */
    }
  }, [vault.id, vault.user_id]);
  useEffect(() => { void load(); }, [load]);

  const p: React.CSSProperties = { fontSize: 17, color: colors.text, lineHeight: 1.6, margin: `0 0 ${space[2]}px` };
  const sub: React.CSSProperties = { fontSize: 17, color: colors.sub, lineHeight: 1.6, margin: `0 0 ${space[2]}px` };
  const h: React.CSSProperties = { fontFamily: fonts.display, fontSize: 18, color: colors.gold, marginBottom: space[2] };
  const leaves = vault.leaves ?? [];

  if (me == null) return <Card><p style={sub}>Loading...</p></Card>;

  if (!isOwner) {
    const mine = members.find(m => m.user_id === me) ?? null;
    const path = leaves[0] ?? null;
    return (
      <Card>
        <div style={h}>Not active yet</div>
        <p style={p}>
          You have joined <strong>{vault.name}</strong>. The person who invited you is still setting it up; it
          becomes a real vault once every key is in place and they finalize it.
        </p>
        {path && (
          <p style={sub}>
            Your path is "{path.label}": {whoSignsWords(path.quorum, path.planned_keys ?? Math.max(path.keys.length, path.quorum), path.planned_required ?? 0)}{' '}
            must sign together.{' '}
            {path.unlock.type === 'immediate'
              ? 'It can be used right away.'
              : path.unlock.type === 'after'
                ? `It opens ${durationWords(path.unlock.blocks)} after the vault is finalized.`
                : `It opens only if the vault sits untouched for ${durationWords(path.unlock.blocks)}.`}
          </p>
        )}
        {mine?.fingerprint && !mine.key_confirmed_at && (
          <>
            <p style={{ ...p, color: colors.orange }}>They still need to confirm your key. Read them this fingerprint, by phone or in person:</p>
            <div style={{ fontFamily: fonts.mono, fontSize: 24, letterSpacing: '0.12em', color: colors.gold, margin: `${space[2]}px 0 ${space[3]}px` }}>
              {mine.fingerprint}
            </div>
          </>
        )}
        {mine?.key_confirmed_at && (
          <p style={{ ...p, color: colors.green }}>
            Your key <span style={{ fontFamily: fonts.mono }}>{mine.fingerprint}</span> is confirmed. Nothing more
            is needed from you until the vault is finalized.
          </p>
        )}
        <p style={{ ...sub, marginBottom: 0 }}>
          Keep the 24 words for this key safe. They are the only way to bring it back on a new phone.
        </p>
      </Card>
    );
  }

  const now = Date.now();
  const total = leaves.reduce((n, l) => n + (l.planned_keys ?? Math.max(l.keys.length, l.quorum)) + (l.planned_required ?? 0), 0);
  const filled = leaves.reduce((n, l) => n + l.keys.length + (l.required_keys ?? []).length, 0);
  const invited = members.filter(m => m.user_id !== vault.user_id && m.status === 'active' && m.leaf_id);
  const toConfirm = invited.filter(m => m.fingerprint && !m.key_confirmed_at);
  const waiting = invites.filter(i => i.leaf_id && !i.claimed_at && new Date(i.expires_at).getTime() > now);
  const label = (id: string | null | undefined) => leaves.find(l => l.id === id)?.label ?? 'a path';

  return (
    <Card>
      <div style={h}>Still being set up</div>
      <p style={p}>
        {filled} of {total} key slots are filled. This vault has no address yet and cannot hold coins until every
        slot is filled and you finalize it.
      </p>
      {toConfirm.map(m => (
        <p key={m.id} style={{ ...p, color: colors.orange }}>
          {m.label} has joined "{label(m.leaf_id)}" and is waiting for you to confirm their key.
        </p>
      ))}
      {waiting.map(i => (
        <p key={i.id} style={sub}>
          {i.invited_label} has not joined "{label(i.leaf_id)}" yet. Their link expires {new Date(i.expires_at).toLocaleDateString()}.
        </p>
      ))}
      {invited.filter(m => m.key_confirmed_at).map(m => (
        <p key={m.id} style={sub}>{m.label}'s key on "{label(m.leaf_id)}" is confirmed.</p>
      ))}
      <Button style={{ minHeight: 44, marginTop: space[2] }} onClick={() => navigate('/policy', { state: { resumeVaultId: vault.id } })}>
        Continue setup
      </Button>
    </Card>
  );
}
