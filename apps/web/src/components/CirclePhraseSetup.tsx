import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getTapitCircleMembers } from '../lib/tapit-circle-members';
import { sendCirclePhrasePairOverNostr } from '../lib/circle-phrase-delivery';
import { wrapSentSecret } from '../lib/sent-secrets';
import { api, type CirclePhraseDelivery } from '../lib/api';
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
 * "Save a recoverable copy" encrypts the pair (AES-256-GCM under a
 * password the owner sets, via sent-secrets.ts) and stores it in
 * 032_sent_secrets.sql; SentSecretsPanel is the reveal side.
 *
 * 2026-08-11 follow-up, same session (operator, looking at this exact
 * card after a reload): "These phrases should show they've been sent
 * and not do it again and again. And have a change button to edit it."
 * Send status used to live only in local useState -- gone on reload, so
 * the form always looked untouched and invited a resend every time.
 * 034_circle_phrase_deliveries.sql now persists who received it and
 * when (never the phrase text itself, same as before). The form starts
 * LOCKED (a summary + per-member status, no text inputs) whenever at
 * least one delivery is on file; "Change phrase" is the only way back
 * into the editable form, so this card no longer defaults to inviting a
 * resend the moment the owner looks at it again.
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
  const [sendingAll, setSendingAll] = useState(false);
  const [deliveries, setDeliveries] = useState<CirclePhraseDelivery[]>([]);
  const [unlocked, setUnlocked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

  // Load the persisted delivery roster on mount. Starts locked (summary
  // view) whenever at least one member already has a delivery on file;
  // starts unlocked (the original always-editable form) the first time,
  // when nothing has ever been sent. A load failure fails OPEN (editable,
  // just without persisted status showing yet) rather than blocking the
  // owner from sending at all.
  useEffect(() => {
    let alive = true;
    void api.circlePhraseDeliveries.list(vaultId).then(res => {
      if (!alive) return;
      setDeliveries(res.deliveries);
      setUnlocked(res.deliveries.length === 0);
      setLoaded(true);
    }).catch(() => {
      if (!alive) return;
      setUnlocked(true);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [vaultId]);

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

  function deliveryFor(keyId: string): CirclePhraseDelivery | null {
    return deliveries.find(d => d.recipient_key_id === keyId) ?? null;
  }

  // Shared low-level delivery, used by both the per-member Send button and
  // Send to all -- one place that actually talks to Nostr, so the two
  // entry points can never drift in behavior. Persists a delivery record
  // on success/queue so the status survives a reload.
  async function deliverTo(
    keyId: string,
    xOnlyPubkey: string,
    label: string,
    persona: string,
  ): Promise<'delivered' | 'queued' | 'failed'> {
    if (!vaultDescriptor) return 'failed';
    try {
      const result = await sendCirclePhrasePairOverNostr({
        vaultDescriptor,
        vaultName,
        normalPhrase: normalPhrase.trim(),
        duressPhrase: duressPhrase.trim(),
        recipientXOnlyPubkey: xOnlyPubkey,
      });
      const outcome = result.delivered ? 'delivered' : 'queued';
      const saved = await api.circlePhraseDeliveries.upsert({
        vault_id: vaultId,
        recipient_key_id: keyId,
        recipient_label: label,
        recipient_persona: persona,
        status: outcome,
      });
      setDeliveries(prev => [...prev.filter(d => d.id !== saved.delivery.id), saved.delivery]);
      return outcome;
    } catch {
      return 'failed';
    }
  }

  async function sendTo(keyId: string, xOnlyPubkey: string, label: string, persona: string) {
    if (!ready || !vaultDescriptor) return;
    setBusyKeyId(keyId);
    const outcome = await deliverTo(keyId, xOnlyPubkey, label, persona);
    if (outcome === 'failed') {
      toast.error(`Failed to send to ${label}`);
    } else {
      toast.success(
        outcome === 'delivered'
          ? `Sent to ${label}`
          : `Queued for ${label} -- no relay confirmed yet, will keep retrying`,
      );
    }
    setBusyKeyId(null);
  }

  // "It should automatically send it to each member of the vault when we
  // click send" (operator, 2026-08-11) -- one action instead of clicking
  // Send N times. Sequential, not parallel, so relay/toast noise stays
  // readable and one member's slow connection doesn't race another's.
  // Individual Send buttons stay below for a one-off resend (e.g. someone
  // was offline the first time).
  async function sendToAll() {
    if (!ready || !vaultDescriptor) return;
    setSendingAll(true);
    let delivered = 0, queued = 0, failed = 0;
    for (const k of circleMembers) {
      if (!k.tapitXOnlyPubkey) continue;
      setBusyKeyId(k.keyId);
      const outcome = await deliverTo(k.keyId, k.tapitXOnlyPubkey, k.label, k.persona);
      if (outcome === 'delivered') delivered++;
      else if (outcome === 'queued') queued++;
      else failed++;
    }
    setBusyKeyId(null);
    setSendingAll(false);
    const parts = [
      delivered > 0 ? `${delivered} delivered` : null,
      queued > 0 ? `${queued} queued` : null,
      failed > 0 ? `${failed} failed` : null,
    ].filter((p): p is string => p !== null);
    toast[failed > 0 ? 'error' : 'success'](`Sent to circle: ${parts.join(', ') || 'nobody to send to'}`);
    // Lock back down once everyone the owner meant to reach has a
    // delivery on file -- a reload would show the same locked summary
    // anyway; doing it right away avoids the form sitting open and
    // "inviting a resend" the moment sendToAll finishes.
    if (failed === 0) setUnlocked(false);
  }

  function changePhrase() {
    setNormalPhrase('');
    setDuressPhrase('');
    setSavedOk(false);
    setUnlocked(true);
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

  const sentCount = circleMembers.filter(k => deliveryFor(k.keyId) !== null).length;

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

      {!unlocked && loaded ? (
        <>
          <p style={{ fontSize: 12, color: colors.muted, marginBottom: 12 }}>
            Phrase set -- sent to {sentCount} of {circleMembers.length} member{circleMembers.length === 1 ? '' : 's'}.
            It's never stored here in plain text, so this card can't show you what it is -- only that it went out.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
            {circleMembers.map(k => {
              const d = deliveryFor(k.keyId);
              return (
                <div key={k.keyId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontSize: 13, color: colors.text, minWidth: 0 }}>
                    {k.label} <span style={{ color: colors.muted }}>({k.persona})</span>
                  </div>
                  <div style={{ fontSize: 11, color: d ? (d.status === 'delivered' ? colors.green : colors.gold) : colors.sub, flexShrink: 0 }}>
                    {d ? `${d.status === 'delivered' ? 'Sent' : 'Queued'} -- ${new Date(d.delivered_at).toLocaleDateString()}` : 'Not sent yet'}
                  </div>
                </div>
              );
            })}
          </div>
          <Button variant="ghost" size="sm" style={{ fontSize: 12 }} onClick={changePhrase}>
            Change phrase
          </Button>
        </>
      ) : (
        <>
          <p style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
            Pick one word or phrase your circle uses to confirm it's really you on a call, and a
            different duress phrase that silently means "I'm being forced." Send both, once, to each
            circle member's Tapit wallet.
          </p>

          <div
            style={{
              background: colors.dangerBg,
              border: `1px solid ${colors.borderDanger}`,
              borderRadius: 8,
              padding: '10px 12px',
              marginBottom: 14,
            }}
          >
            <p style={{ fontSize: 12, color: colors.red, fontWeight: 600, marginBottom: 4 }}>
              Remember this phrase -- there is no reset.
            </p>
            <p style={{ fontSize: 12, color: colors.sub, lineHeight: 1.5 }}>
              Once this is sent, your circle's phone-verification ritual depends on it: if you forget
              it, you can't correctly confirm yourself (or a duress signal) to any circle member on a
              call, and signing for this vault effectively stalls until you pick a new phrase and
              re-send it to everyone. It is never stored here in plain text, so there's no support
              path to look it up for you. <strong>Save a recoverable copy below before you send</strong> --
              that's the only way back if it slips your mind.
            </p>
          </div>

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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Button
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

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <Button
              variant="ghost"
              size="sm"
              style={{ fontSize: 12 }}
              disabled={!ready || sendingAll || busyKeyId !== null}
              onClick={() => void sendToAll()}
            >
              {sendingAll ? 'Sending to circle…' : `Send to all (${circleMembers.length})`}
            </Button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {circleMembers.map(k => {
              const d = deliveryFor(k.keyId);
              return (
                <div key={k.keyId} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: 13, color: colors.text, minWidth: 0 }}>
                      {k.label} <span style={{ color: colors.muted }}>({k.persona})</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      style={{ fontSize: 12, flexShrink: 0 }}
                      disabled={!ready || sendingAll || busyKeyId === k.keyId}
                      onClick={() => void sendTo(k.keyId, k.tapitXOnlyPubkey!, k.label, k.persona)}
                    >
                      {busyKeyId === k.keyId
                        ? 'Sending…'
                        : d
                          ? d.status === 'delivered' ? 'Resend' : 'Queued -- retrying'
                          : 'Send'}
                    </Button>
                  </div>
                  {d && (
                    <div style={{ fontSize: 11, color: d.status === 'delivered' ? colors.green : colors.gold, paddingLeft: 2 }}>
                      {d.status === 'delivered' ? 'Sent' : 'Queued'} -- {new Date(d.delivered_at).toLocaleString()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
