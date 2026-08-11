import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getTapitCircleMembers } from '../lib/tapit-circle-members';
import { sendCirclePhrasePairOverNostr } from '../lib/circle-phrase-delivery';
import { wrapSentSecret } from '../lib/sent-secrets';
import { api } from '../lib/api';
import { colors, radii, space } from '../theme';
import { Button, Input, Label } from './ui';
import { useToast } from './toast';
import { usePrompt } from './dialog';

/**
 * CirclePhraseSetup -- the owner's side of the phone-callback phrase pair
 * (2026-08-08 follow-up). Visible only when the vault has at least one
 * Tapit-origin founder key on file (a Tapit Circle vault, or any vault
 * where the owner pasted in a circle member's Tapit pubkey). One shared
 * normal phrase + one shared duress phrase for the whole circle, typed
 * once here and sent, NIP-44 encrypted, to each member -- never stored on
 * this side once the sends resolve.
 *
 * 2026-08-11 fix (operator: "if you forgot, then you're not gonna be
 * able to say the right thing... it doesn't need to be sitting in plain
 * text, but it does need to be able to be revealed with your password"):
 * the phrase pair used to genuinely vanish from this side the moment the
 * form unmounted -- no way to recall what was sent if the owner forgot.
 * "Save a recoverable copy" encrypts the pair (AES-256-GCM under a
 * password the owner sets, via sent-secrets.ts -- same primitives as
 * every other password-encrypted blob in this app) and stores it in
 * 032_sent_secrets.sql; SentSecretsPanel is the reveal side.
 */
export function CirclePhraseSetup({
  vaultId,
  vaultDescriptor,
  vaultName,
  founderKeys,
}: {
  vaultId: string;
  vaultDescriptor: string | null;
  vaultName: string;
  founderKeys: string[];
}) {
  const toast = useToast();
  const askPassword = usePrompt();
  const [normalPhrase, setNormalPhrase] = useState('');
  const [duressPhrase, setDuressPhrase] = useState('');
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<Map<string, 'delivered' | 'queued'>>(new Map());
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

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

  async function saveRecoverableCopy() {
    if (!ready) return;
    const password = await askPassword({
      title: 'Save a recoverable copy',
      message:
        "Set a password to encrypt this phrase pair for later recall. You'll need this exact password to reveal it again -- there is no reset, so pick one you'll actually remember.",
      password: true,
      confirmLabel: 'Save',
    });
    if (!password) return;
    setSaving(true);
    try {
      const blob = await wrapSentSecret(
        { normalPhrase: normalPhrase.trim(), duressPhrase: duressPhrase.trim() },
        password,
      );
      await api.sentSecrets.create({
        vault_id: vaultId,
        kind: 'circle_phrase',
        label: 'Circle safety phrase',
        recipients: circleMembers.map(k => ({ label: k.label, persona: k.persona })),
        blob: { ciphertextB64: blob.ciphertextB64, saltB64: blob.saltB64, nonceB64: blob.nonceB64 },
      });
      setSavedOk(true);
      toast.success('Saved -- reveal it later from "Secrets sent" below with your password');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
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
        circle member's Tapit wallet -- they're never stored here after the send, unless you save
        a recoverable copy below.
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button
            variant="ghost"
            size="sm"
            style={{ fontSize: 12 }}
            disabled={!ready || saving}
            onClick={() => void saveRecoverableCopy()}
          >
            {saving ? 'Saving…' : savedOk ? 'Save another copy' : 'Save a recoverable copy'}
          </Button>
          {savedOk && (
            <span style={{ fontSize: 11, color: colors.gold }}>
              Saved -- see "Secrets sent" below to reveal it later
            </span>
          )}
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
