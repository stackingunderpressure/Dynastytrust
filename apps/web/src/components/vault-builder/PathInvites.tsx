import { useState } from 'react';
import { api, type VaultInvite, type VaultMember } from '../../lib/api';
import type { SelectedKey } from '../../lib/descriptor-keys';
import { memberToSelected, openSlots, peopleOnPath } from '../../lib/path-people';
import { colors, fonts, radii, space } from '../../theme';
import { Button, Input, Label } from '../ui';
import { useToast } from '../toast';

// The people on one path of a vault being set up (journey gap J3).
//
// Sits under the path's own key picker in the builder's Keys step. The
// owner can still fill any slot from their own device exactly as
// before; this adds "someone else holds this key, on their device":
//   invite (name + the email they sign in with)  ->  they join with a
//   key made on their phone  ->  the owner checks the fingerprint with
//   them by voice and confirms  ->  the key fills the slot.
// The server refuses to finalize a vault holding an unconfirmed member
// key (compile-leaves.js), so this screen is the convenient path, not
// the guard.

export function PathInvites({
  vaultId,
  network,
  ownerUserId,
  leaf,
  selected,
  setSelected,
  invites,
  members,
  reload,
}: {
  vaultId: string;
  network: string;
  ownerUserId: string;
  leaf: { id: string; label: string; plannedKeys: number };
  selected: SelectedKey[];
  setSelected: (fn: (p: SelectedKey[]) => SelectedKey[]) => void;
  invites: VaultInvite[];
  members: VaultMember[];
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const people = peopleOnPath(leaf.id, invites, members, ownerUserId, selected, new Date());
  const free = openSlots(leaf.plannedKeys, selected, people);
  const linkFor = (i: VaultInvite) => `${window.location.origin}/invite/${i.token}`;

  async function copyLink(i: VaultInvite) {
    try {
      await navigator.clipboard.writeText(linkFor(i));
      setCopied(i.id);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      toast.error('Copy failed -- press and hold the link to copy it.');
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.invites.create({ vault_id: vaultId, leaf_id: leaf.id, invited_label: name.trim(), invited_email: email.trim() });
      setName('');
      setEmail('');
      setFormOpen(false);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  async function cancelInvite(i: VaultInvite) {
    setBusy(true);
    try {
      await api.invites.revoke(i.id);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not cancel the invite');
    } finally {
      setBusy(false);
    }
  }

  function addMemberKey(m: VaultMember) {
    const sk = memberToSelected(m, network);
    if (!sk) return;
    setSelected(p => (p.some(k => k.keyId === sk.keyId) || p.length >= leaf.plannedKeys ? p : [...p, sk]));
  }

  async function confirm(m: VaultMember) {
    if (!m.fingerprint) return;
    setBusy(true);
    try {
      const res = await api.members.confirmKey(m.id, m.fingerprint);
      await reload();
      addMemberKey(res.member);
      toast.success(`${m.label ?? 'Their'} key is confirmed and added to "${leaf.label}".`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not confirm the key');
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: VaultMember) {
    setBusy(true);
    try {
      await api.members.remove(m.id);
      setSelected(p => p.filter(k => k.keyId !== `member:${m.id}`));
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove this person');
    } finally {
      setBusy(false);
    }
  }

  const row: React.CSSProperties = {
    background: colors.inset, borderRadius: radii.md, padding: space[3], marginTop: space[2],
    fontSize: 14, color: colors.text, lineHeight: 1.55,
  };
  const sub: React.CSSProperties = { fontSize: 13, color: colors.sub, lineHeight: 1.55, margin: `${space[1]}px 0 ${space[2]}px` };
  const fp: React.CSSProperties = { fontFamily: fonts.mono, color: colors.gold, letterSpacing: '0.08em' };

  // Nothing to offer on a path whose slots are all filled from this device.
  if (free === 0 && people.length === 0 && !formOpen) return null;

  return (
    <div style={{ marginTop: space[3], borderTop: `1px solid ${colors.divider}`, paddingTop: space[3] }}>
      {free > 0 && (
        <div style={{ fontSize: 13, color: colors.sub, lineHeight: 1.55 }}>
          Should someone else hold a key on this path? They make it on their own phone, so it never touches yours.
        </div>
      )}

      {people.map(p => {
        if (p.kind === 'invited') {
          return (
            <div key={p.invite.id} style={row}>
              <strong>{p.invite.invited_label}</strong> -- waiting for them to join
              <div style={sub}>
                Send them this link yourself. It only works when they sign in as {p.invite.invited_email}, and it
                expires on {new Date(p.invite.expires_at).toLocaleDateString()}.
              </div>
              <div style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.muted, wordBreak: 'break-all', marginBottom: space[2] }}>
                {linkFor(p.invite)}
              </div>
              <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap' }}>
                <Button size="sm" style={{ minHeight: 40 }} onClick={() => void copyLink(p.invite)}>
                  {copied === p.invite.id ? 'Copied' : 'Copy link'}
                </Button>
                <Button size="sm" variant="ghost" style={{ minHeight: 40 }} disabled={busy} onClick={() => void cancelInvite(p.invite)}>
                  Cancel invite
                </Button>
              </div>
            </div>
          );
        }
        const m = p.member;
        if (p.kind === 'joined') {
          return (
            <div key={m.id} style={{ ...row, border: `1px solid ${colors.orange}66` }}>
              <strong>{m.label}</strong> has joined. Their key's fingerprint is <span style={fp}>{m.fingerprint}</span>
              <div style={sub}>
                Call them, or ask in person. Have them open Keys on their phone and read you the fingerprint of the
                key they made. Confirm only if it is exactly this. This is how you know the key is really theirs
                and not someone else's who got hold of the link.
              </div>
              <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap' }}>
                <Button size="sm" style={{ minHeight: 40 }} disabled={busy} onClick={() => void confirm(m)}>
                  It matches -- confirm
                </Button>
                <Button size="sm" variant="danger" style={{ minHeight: 40 }} disabled={busy} onClick={() => void remove(m)}>
                  It does not match -- remove
                </Button>
              </div>
            </div>
          );
        }
        return (
          <div key={m.id} style={row}>
            <strong>{m.label}</strong> -- key confirmed <span style={fp}>{m.fingerprint}</span>
            {p.inSlot ? (
              <div style={sub}>Their key fills a slot on this path.</div>
            ) : (
              <div style={{ marginTop: space[2] }}>
                <Button size="sm" style={{ minHeight: 40 }} disabled={selected.length >= leaf.plannedKeys} onClick={() => addMemberKey(m)}>
                  Add their key to this path
                </Button>
              </div>
            )}
          </div>
        );
      })}

      {free > 0 && !formOpen && (
        <Button size="sm" variant="ghost" style={{ minHeight: 40, marginTop: space[2] }} onClick={() => setFormOpen(true)}>
          + Invite someone to hold a key
        </Button>
      )}

      {formOpen && (
        <form onSubmit={invite} style={{ ...row, display: 'flex', flexDirection: 'column', gap: space[2] }}>
          <div>
            <Label>Their name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Anna" required maxLength={80} />
          </div>
          <div>
            <Label>The email they sign in with</Label>
            <Input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="anna@example.com"
              autoCapitalize="none"
              autoCorrect="off"
              required
            />
          </div>
          <div style={{ fontSize: 13, color: colors.sub, lineHeight: 1.55 }}>
            You get a link to send them. Only that email address can use it, and their key goes into the vault
            only after you confirm it with them.
          </div>
          {err && <div style={{ fontSize: 13, color: colors.red }}>{err}</div>}
          <div style={{ display: 'flex', gap: space[2] }}>
            <Button type="button" size="sm" variant="ghost" style={{ minHeight: 40 }} onClick={() => { setFormOpen(false); setErr(null); }}>
              Cancel
            </Button>
            <Button type="submit" size="sm" style={{ minHeight: 40 }} disabled={busy}>
              {busy ? 'Working...' : 'Create invite link'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
