import { useCallback, useEffect, useState } from 'react';
import { api, type SentSecret } from '../lib/api';
import { unwrapSentSecret } from '../lib/sent-secrets';
import {
  isFaceGateSupported, hasFaceGateCredential, registerFaceGate, verifyFaceGate,
  getCachedSecretPassword, setCachedSecretPassword, clearCachedSecretPassword,
  hasFaceIdSecretPassword, saveFaceIdSecretPassword, openFaceIdSecretPassword, clearFaceIdSecretPassword,
} from '../lib/face-gate';
import { passkeysAvailable } from '../lib/passkey';
import { colors, radii, space } from '../theme';
import { Button } from './ui';
import { useToast } from './toast';
import { useConfirm, usePrompt } from './dialog';

const FIELD_LABEL: Record<string, string> = {
  normalPhrase: 'Normal phrase',
  duressPhrase: 'Duress phrase',
};

/**
 * SentSecretsPanel -- the reveal side of "secrets I've sent"
 * (032_sent_secrets.sql). Lists every secret record saved for this
 * vault (label, who it went to, when -- all plain, non-secret
 * bookkeeping) with a per-row Reveal that prompts for the password the
 * owner set when saving and decrypts client-side only. Nothing here is
 * ever plaintext at rest; a wrong password just fails to decrypt (AES-
 * GCM's tag check), same as everywhere else this pattern is used.
 */
export function SentSecretsPanel({ vaultId }: { vaultId: string }) {
  const toast = useToast();
  const askPassword = usePrompt();
  const askConfirm = useConfirm();
  const [secrets, setSecrets] = useState<SentSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState<Map<string, Record<string, string>>>(new Map());
  const [busyId, setBusyId] = useState<string | null>(null);
  // Passwords typed (or read from an old plain copy) on this visit, kept
  // in memory only, so "Use Face ID next time" can lock them on a fresh tap.
  const [justOpened, setJustOpened] = useState<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    try {
      const { secrets } = await api.sentSecrets.list(vaultId);
      setSecrets(secrets);
    } catch {
      /* best-effort -- an empty list just means nothing saved yet */
    } finally {
      setLoading(false);
    }
  }, [vaultId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loading && secrets.length === 0) return null;

  // Reveal, in order: (1) the password's Face ID copy on this device --
  // one prompt, nothing readable stored; (2) an old plain copy behind the
  // older Face ID gate, kept working until it is converted; (3) typing it.
  // After a typed or old-copy reveal, a device that can do real Face ID is
  // offered "Use Face ID next time" (its own tap: Safari only shows Face
  // ID in answer to one), which also deletes the plain copy. A device
  // that cannot keeps the older behaviour, so nobody is made to retype.
  async function reveal(s: SentSecret) {
    setBusyId(s.id);
    try {
      let password: string | null = null;
      let source: 'faceid' | 'old-copy' | 'typed' = 'typed';
      if (hasFaceIdSecretPassword(s.id)) {
        try { password = await openFaceIdSecretPassword(s.id); source = 'faceid'; } catch { password = null; }
      }
      if (!password) {
        const cached = getCachedSecretPassword(s.id);
        if (cached && hasFaceGateCredential() && (await verifyFaceGate())) { password = cached; source = 'old-copy'; }
      }
      if (!password) {
        password = await askPassword({
          title: 'Reveal secret',
          message: `Enter the password you set when you saved "${s.label}".`,
          password: true,
          confirmLabel: 'Reveal',
        });
        if (!password) return;
      }
      const fields = await unwrapSentSecret(
        { version: 1, ciphertextB64: s.ciphertext_b64, saltB64: s.salt_b64, nonceB64: s.nonce_b64 },
        password,
      );
      setRevealed(prev => new Map(prev).set(s.id, fields));
      if (source !== 'faceid') {
        if (passkeysAvailable()) {
          const pw = password;
          setJustOpened(prev => new Map(prev).set(s.id, pw));
        } else {
          // No real Face ID on this browser: the older cached-password gate.
          setCachedSecretPassword(s.id, password);
          if (!hasFaceGateCredential() && (await isFaceGateSupported())) void registerFaceGate();
        }
      }
    } catch {
      toast.error('Wrong password, or this record is corrupt.');
    } finally {
      setBusyId(null);
    }
  }

  async function lockWithFaceIdNextTime(s: SentSecret) {
    const pw = justOpened.get(s.id);
    if (!pw) return;
    setBusyId(s.id);
    try {
      await saveFaceIdSecretPassword(s.id, pw);
      setJustOpened(prev => { const next = new Map(prev); next.delete(s.id); return next; });
      toast.success(`"${s.label}" now opens with Face ID on this phone.`);
    } catch (e) {
      toast.error((e instanceof Error ? e.message : 'Face ID did not work') + ' Nothing was changed.');
    } finally {
      setBusyId(null);
    }
  }

  function hide(id: string) {
    setRevealed(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  async function remove(s: SentSecret) {
    if (!(await askConfirm({
      title: 'Delete this record',
      message: `Delete the saved copy of "${s.label}"? This only removes your own recoverable copy -- it does not un-send anything already delivered.`,
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    try {
      await api.sentSecrets.remove(s.id);
      hide(s.id);
      clearCachedSecretPassword(s.id);
      clearFaceIdSecretPassword(s.id);
      setSecrets(prev => prev.filter(x => x.id !== s.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete');
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
      <div style={{ fontSize: 17, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
        Secrets sent
      </div>
      <p style={{ fontSize: 16, color: colors.muted, marginBottom: 14 }}>
        Things you've saved a recoverable copy of, like the circle safety phrase. Encrypted with
        the password you set when you saved each one -- there is no reset, so the first Reveal on
        a new device still needs that exact password. After that you can lock it with Face ID on
        this phone, so it opens without retyping and no password is kept here in readable form.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {secrets.map(s => {
          const fields = revealed.get(s.id);
          return (
            <div
              key={s.id}
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 8,
                padding: 10,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 17, fontWeight: 600, color: colors.text }}>{s.label}</div>
                  <div style={{ fontSize: 15, color: colors.muted }}>
                    Sent to {s.recipients.length === 0
                      ? 'nobody yet'
                      : s.recipients.map(r => `${r.label} (${r.persona})`).join(', ')}
                    {' -- '}
                    {new Date(s.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {fields ? (
                    <Button variant="ghost" size="sm" style={{ fontSize: 16 }} onClick={() => hide(s.id)}>
                      Hide
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      style={{ fontSize: 16 }}
                      disabled={busyId === s.id}
                      onClick={() => void reveal(s)}
                    >
                      {busyId === s.id ? 'Checking…' : 'Reveal'}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    style={{ fontSize: 16, color: colors.red }}
                    onClick={() => void remove(s)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
              {fields && justOpened.has(s.id) && (
                <Button
                  size="sm"
                  style={{ fontSize: 16, minHeight: 44, marginTop: 10, width: '100%' }}
                  disabled={busyId === s.id}
                  onClick={() => void lockWithFaceIdNextTime(s)}
                >
                  {busyId === s.id ? 'Waiting for Face ID...' : 'Use Face ID next time'}
                </Button>
              )}
              {fields && (
                <div
                  style={{
                    marginTop: 10,
                    paddingTop: 10,
                    borderTop: `1px solid ${colors.border}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  {Object.entries(fields).map(([k, v]) => (
                    <div key={k} style={{ fontSize: 16 }}>
                      <span style={{ color: colors.muted }}>{FIELD_LABEL[k] ?? k}: </span>
                      <span style={{ color: colors.text, fontFamily: 'monospace' }}>{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
