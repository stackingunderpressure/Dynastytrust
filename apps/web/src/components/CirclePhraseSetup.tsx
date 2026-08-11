import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getTapitCircleMembers } from '../lib/tapit-circle-members';
import { sendCirclePhrasePairOverNostr } from '../lib/circle-phrase-delivery';
import { colors, radii, space } from '../theme';
import { Button, Input, Label } from './ui';
import { useToast } from './toast';

/**
 * CirclePhraseSetup -- the owner's side of the phone-callback phrase pair
 * (2026-08-08 follow-up). Visible only when the vault has at least one
 * Tapit-origin founder key on file (a Tapit Circle vault, or any vault
 * where the owner pasted in a circle member's Tapit pubkey). One shared
 * normal phrase + one shared duress phrase for the whole circle, typed
 * once here and sent, NIP-44 encrypted, to each member -- never stored on
 * this side once the sends resolve.
 */
export function CirclePhraseSetup({
  vaultDescriptor,
  vaultName,
  founderKeys,
}: {
  vaultDescriptor: string | null;
  vaultName: string;
  founderKeys: string[];
}) {
  const toast = useToast();
  const [normalPhrase, setNormalPhrase] = useState('');
  const [duressPhrase, setDuressPhrase] = useState('');
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<Map<string, 'delivered' | 'queued'>>(new Map());

  const { circleMembers, barePubkeys } = getTapitCircleMembers(founderKeys);

  if (circleMembers.length === 0) {
    // This card used to just disappear here -- which is indistinguishable
    // from "nothing to see" whether the vault genuinely has no Tapit
    // circle member OR it does and this browser's Key Manager just
    // doesn't hold a matching local key for it (a different device, a
    // cleared keystore, a key that was later archived). Say which one is
    // actually true instead of going silent either way.
    if (barePubkeys.length === 0) return null;
    return (
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: radii.md,
          padding: space[5],
          marginBottom: space[4],
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
          Circle safety phrase
        </div>
        <p style={{ fontSize: 12, color: colors.sub, margin: 0 }}>
          This vault has {barePubkeys.length} founder key{barePubkeys.length === 1 ? '' : 's'} that
          look like they came from Tapit (no extended public key attached), but none of them match a
          Tapit-origin key in this browser's Key Manager right now. If you added that key on a different
          device or browser, add it here too before you can send the safety phrase to that person --{' '}
          <Link to="/keys" style={{ color: colors.gold }}>open Key Manager</Link>.
        </p>
      </div>
    );
  }

  const ready =
    vaultDescriptor !== null &&
    normalPhrase.trim().length > 0 &&
    duressPhrase.trim().length > 0 &&
    normalPhrase.trim().toLowerCase() !== duressPhrase.trim().toLowerCase();

  async function sendTo(keyId: string, xOnlyPubkey: string, label: string) {
    if (!ready || !vaultDescriptor) return;
    setBusyKeyId(keyId);
    try {
      const result = await sendCirclePhrasePairOverNostr({
        vaultDescriptor,
        vaultName,
        normalPhrase: normalPhrase.trim(),
        duressPhrase: duressPhrase.trim(),
        recipientXOnlyPubkey: xOnlyPubkey,
      });
      setSentTo(prev => new Map(prev).set(keyId, result.delivered ? 'delivered' : 'queued'));
      toast.success(
        result.delivered
          ? `Sent to ${label}`
          : `Queued for ${label} -- no relay confirmed yet, will keep retrying`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to send');
    } finally {
      setBusyKeyId(null);
    }
  }

  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        padding: space[5],
        marginBottom: space[4],
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
        Circle safety phrase
      </div>
      <p style={{ fontSize: 12, color: colors.muted, marginBottom: 14 }}>
        Pick one word or phrase your circle uses to confirm it's really you on a call, and a
        different duress phrase that silently means "I'm being forced." Send both, once, to each
        circle member's Tapit wallet -- they're never stored here after the send.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
        <div>
          <Label>Normal phrase</Label>
          <Input
            value={normalPhrase}
            onChange={e => setNormalPhrase(e.target.value)}
            placeholder="e.g. blue harbor"
          />
        </div>
        <div>
          <Label>Duress phrase (different from above)</Label>
          <Input
            value={duressPhrase}
            onChange={e => setDuressPhrase(e.target.value)}
            placeholder="e.g. red harbor"
          />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {circleMembers.map(k => (
          <div key={k.keyId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 13, color: colors.text, minWidth: 0 }}>
              {k.label} <span style={{ color: colors.muted }}>({k.persona})</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 12, flexShrink: 0 }}
              disabled={!ready || busyKeyId === k.keyId}
              onClick={() => void sendTo(k.keyId, k.tapitXOnlyPubkey!, k.label)}
            >
              {sentTo.get(k.keyId) === 'delivered'
                ? 'Sent'
                : sentTo.get(k.keyId) === 'queued'
                  ? 'Queued -- retrying'
                  : busyKeyId === k.keyId
                    ? 'Sending…'
                    : 'Send'}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
