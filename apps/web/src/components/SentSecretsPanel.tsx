import { useCallback, useEffect, useState } from 'react';
import { api, type SentSecret } from '../lib/api';
import { unwrapSentSecret } from '../lib/sent-secrets';
import {
  isFaceGateSupported, hasFaceGateCredential, registerFaceGate, verifyFaceGate,
  getCachedSecretPassword, setCachedSecretPassword, clearCachedSecretPassword,
} from '../lib/face-gate';
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

  // Face ID reveal: if this secret's password is already cached on this
  // device (set the first time it was ever typed in successfully) and a
  // Face ID/Touch ID credential is registered, a successful biometric
  // check hands back the cached password with no typing at all. Anything
  // that isn't a clean Face ID pass -- no cache yet, no credential
  // registered, declined, unsupported browser -- falls through to the
  // password prompt exactly as before, so there's always a way in.
  async function reveal(s: SentSecret) {
    setBusyId(s.id);
    try {
      let password: string | null = null;
      const cached = getCachedSecretPassword(s.id);
      if (cached && hasFaceGateCredential()) {
        password = (await verifyFaceGate()) ? cached : null;
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
      // Correct password, decrypted clean -- cache it and, the first time
      // this happens on a device that can do Face ID, register the gate
      // so every reveal after this one skips the typed password.
      setCachedSecretPassword(s.id, password);
      if (!hasFaceGateCredential() && (await isFaceGateSupported())) {
        void registerFaceGate();
      }
    } catch {
      toast.error('Wrong password, or this record is corrupt.');
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
      <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
        Secrets sent
      </div>
      <p style={{ fontSize: 12, color: colors.muted, marginBottom: 14 }}>
        Things you've saved a recoverable copy of, like the circle safety phrase. Encrypted with
        the password you set when you saved each one -- there is no reset, so the first Reveal on
        a new device still needs that exact password. After that, Face ID / Touch ID unlocks it on
        this device without retyping anything.
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
                  <div style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>{s.label}</div>
                  <div style={{ fontSize: 11, color: colors.muted }}>
                    Sent to {s.recipients.length === 0
                      ? 'nobody yet'
                      : s.recipients.map(r => `${r.label} (${r.persona})`).join(', ')}
                    {' -- '}
                    {new Date(s.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {fields ? (
                    <Button variant="ghost" size="sm" style={{ fontSize: 12 }} onClick={() => hide(s.id)}>
                      Hide
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      style={{ fontSize: 12 }}
                      disabled={busyId === s.id}
                      onClick={() => void reveal(s)}
                    >
                      {busyId === s.id ? 'Checking…' : 'Reveal'}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    style={{ fontSize: 12, color: colors.red }}
                    onClick={() => void remove(s)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
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
                    <div key={k} style={{ fontSize: 12 }}>
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
