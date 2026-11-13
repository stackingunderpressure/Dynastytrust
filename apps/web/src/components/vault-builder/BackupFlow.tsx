import { useState } from 'react';
import { markBackedUp, protectKeyWithPasskey, type LocalKey } from '../../lib/keystore';
import { passkeysAvailable } from '../../lib/passkey';
import { colors, fonts, radii, space } from '../../theme';
import { Button, Input, Label } from '../ui';

// Self-contained modal shell used only by BackupFlow below. Deliberately
// NOT the shared components/ui/Modal.tsx: a tap on the dark backdrop never
// closes it, so nobody leaves the backup by accident. Leaving on purpose is
// the close button, shown only when the caller says what leaving means
// (`onClose`). Before 2026-11-13 the button was always drawn and did
// nothing (operator, on his phone: "No exit on this screen").
export function BackupModal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose?: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.78)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
        padding: space[4],
      }}
    >
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          padding: 'clamp(18px, 5vw, 28px) clamp(16px, 5vw, 32px)',
          width: '100%',
          maxWidth: wide ? 660 : 520,
          maxHeight: '92vh',
          overflowY: 'auto',
          fontFamily: fonts.sans,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, color: colors.text, fontFamily: fonts.display, margin: 0 }}>
            {title}
          </h2>
          {onClose && (
            <Button variant="ghost" size="sm" aria-label="Close" style={{ minWidth: 44, minHeight: 44, flexShrink: 0 }} onClick={onClose}>
              x
            </Button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

export function WordGrid({ words }: { words: string[] }) {
  const [vis, setVis] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
        <Button variant="ghost" size="sm" style={{ fontSize: 16, padding: '4px 10px' }} onClick={() => setVis(v => !v)}>
          {vis ? 'Hide' : 'Reveal words'}
        </Button>
      </div>
      {/* As many columns as fit: two on a phone, four on a wide screen. A
          fixed four ran the last column off a phone's edge. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 5 }}>
        {words.map((w, i) => (
          <div
            key={i}
            style={{
              background: colors.inset,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              padding: '6px 10px',
              display: 'flex',
              gap: 6,
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 14, color: colors.muted, minWidth: 16, flexShrink: 0 }}>{i + 1}</span>
            <span
              style={{
                fontSize: 16,
                fontFamily: fonts.mono,
                color: vis ? colors.text : 'transparent',
                textShadow: vis ? 'none' : `0 0 8px ${colors.muted}`,
                userSelect: vis ? 'text' : 'none',
              }}
            >
              {w}
            </span>
          </div>
        ))}
      </div>
      {/* No copy button: the words go on paper, never onto the clipboard,
          where other apps can read them (operator, 2026-11-13). */}
    </div>
  );
}

// Two-step progress caption for the backup flow.
function StepIndicator({ current }: { current: 1 | 2 }) {
  const labels = ['Write it down', 'Verify'];
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
      {labels.map((label, i) => {
        const n = (i + 1) as 1 | 2;
        const active = n === current;
        const done = n < current;
        return (
          <div key={label} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 15,
                fontWeight: 700,
                background: active || done ? colors.gold : colors.raised,
                color: active || done ? colors.bg : colors.muted,
              }}
            >
              {n}
            </span>
            <span style={{ fontSize: 16, color: active ? colors.text : colors.muted }}>
              {label}
            </span>
            {i === 0 && <span style={{ color: colors.muted, margin: '0 2px' }}>-</span>}
          </div>
        );
      })}
    </div>
  );
}

// Shown once, immediately after a new key is generated -- the entry point
// into BackupFlow below, not a gate itself. Backing up is real work (write
// 24 words on paper, retype four of them) and forcing it before someone can
// even continue building their vault means the mnemonic gets rushed past
// or the whole flow gets abandoned. So this offers the choice KeyManager.tsx
// already gives standalone key generation: back up right now, or take the
// key and keep going -- it's flagged `backedUp: false` in keystore.ts either
// way, and stays visible as a reminder (KeyPicker's "Not backed up" badge)
// until someone actually verifies it, here or later from Key Manager.
export function KeyCreatedPrompt({
  keyData,
  mnemonic,
  onBackupNow,
  onBackupLater,
}: {
  keyData: LocalKey;
  mnemonic: string;
  onBackupNow: () => void;
  onBackupLater: () => void;
}) {
  return (
    <BackupModal title="Key created" onClose={onBackupLater} wide>
      <div style={{ padding: '10px 14px', background: colors.successBg, border: `1px solid ${colors.green}44`, borderRadius: radii.md, marginBottom: 16 }}>
        <p style={{ fontSize: 17, color: colors.green, margin: 0 }}>
          <strong>{keyData.label}</strong> is ready to use in the vault. Its recovery phrase is below -- tap "Reveal
          words" to see it.
        </p>
      </div>
      <WordGrid words={mnemonic.split(' ')} />
      <p style={{ fontSize: 16, color: colors.muted, marginTop: 12, marginBottom: 0 }}>
        Backing it up now means writing all 24 words down and confirming a few of them. You can also do this later --
        the key works in the vault either way, and it'll be flagged "not backed up" until you do. This key lives
        only in this browser on this device: if the browser's data is cleared or you change phones, these words
        are the only way to bring it back.
      </p>
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <Button variant="ghost" style={{ flex: 1 }} onClick={onBackupLater}>
          Back up later
        </Button>
        <Button style={{ flex: 1 }} onClick={onBackupNow}>
          Back up now
        </Button>
      </div>
    </BackupModal>
  );
}

// Mandatory write-down-then-verify backup ritual -- reached by choice, via
// "Back up now" above (or "Verify backup" later from Key Manager), never
// forced on first generation. Relocated out of KeyManager.tsx so both
// standalone key management and the unified wizard's inline key-creation
// step share one implementation instead of a second copy being born.
// Leaving early is allowed when the caller passes `onCancel`, and it is
// honest: the key stays marked "not backed up" -- only finishing the
// verify step marks it backed up -- so nobody ends up thinking they are
// covered when they are not. A tap on the backdrop never leaves.
export function BackupFlow({ keyData, mnemonic, onDone, onCancel }: { keyData: LocalKey; mnemonic: string; onDone: () => void; onCancel?: () => void }) {
  const words = mnemonic.split(' ');
  const [step, setStep] = useState<'show' | 'verify' | 'lock'>('show');
  const [locking, setLocking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [positions] = useState<number[]>(() => {
    const p: number[] = [];
    while (p.length < 4) {
      const n = Math.floor(Math.random() * 24);
      if (!p.includes(n)) p.push(n);
    }
    return p.sort((a, b) => a - b);
  });
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [err, setErr] = useState<string | null>(null);

  function verify() {
    const wrong = positions.filter(p => answers[p]?.trim().toLowerCase() !== words[p]);
    if (wrong.length) {
      setErr('Wrong: ' + wrong.map(p => '#' + (p + 1)).join(', '));
      return;
    }
    markBackedUp(keyData.keyId);
    // Operator, 2026-11-13: "Make browser keys Face ID for everything
    // important." A key held in this browser is offered Face ID the moment
    // its written backup is proven -- the one point where the way back
    // exists AND the words are already on screen, so no password is asked.
    // Test keys (test coins only) and hardware keys are not offered it.
    if (keyData.origin === 'software' && !keyData.testMnemonic && !keyData.passkeyMnemonic && passkeysAvailable()) {
      setErr(null);
      setStep('lock');
      return;
    }
    onDone();
  }

  async function lockWithFaceId() {
    setErr(null);
    setLocking(true);
    try {
      await protectKeyWithPasskey(keyData.keyId, { mnemonic });
      onDone();
    } catch (e) {
      setErr((e instanceof Error ? e.message : 'Face ID could not lock this key') + ' The key keeps its password.');
    } finally {
      setLocking(false);
    }
  }

  if (step === 'lock')
    return (
      <BackupModal title="Lock this key with Face ID">
        <p style={{ fontSize: 17, color: colors.text, lineHeight: 1.6, marginTop: 0 }}>
          Your backup is checked. Now choose how this phone unlocks the key when you sign.
        </p>
        <p style={{ fontSize: 17, color: colors.sub, lineHeight: 1.6 }}>
          With Face ID (or your fingerprint) there is no password to forget, guess or have read as you type it.
          Your phone asks two or three times now to prove it works. After that the password is gone; the ways
          back are Face ID and the 24 words you just wrote down. You can switch back to a password later on the Keys page.
        </p>
        {err && <p style={{ color: colors.red, fontSize: 17 }}>{err}</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
          <Button style={{ width: '100%', minHeight: 44 }} disabled={locking} onClick={() => void lockWithFaceId()}>
            {locking ? 'Waiting for Face ID...' : 'Lock with Face ID'}
          </Button>
          <Button variant="ghost" style={{ width: '100%', minHeight: 44 }} disabled={locking} onClick={onDone}>
            Keep the password
          </Button>
        </div>
      </BackupModal>
    );

  if (step === 'show')
    return (
      <BackupModal title="Write down your recovery phrase" onClose={onCancel} wide>
        <StepIndicator current={1} />
        <div style={{ padding: '10px 14px', background: colors.dangerBg, border: `1px solid ${colors.borderDanger}`, borderRadius: radii.md, marginBottom: 16 }}>
          <p style={{ fontSize: 17, color: colors.red, margin: 0 }}>
            Write all 24 words on paper in order. Never store digitally or share.
          </p>
        </div>
        <WordGrid words={words} />
        <label
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            cursor: 'pointer',
            marginTop: 16,
            padding: 12,
            background: colors.raised,
            borderRadius: radii.md,
          }}
        >
          <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
          <span style={{ fontSize: 17, color: colors.sub }}>I have written all 24 words in order.</span>
        </label>
        <Button
          style={{ width: '100%', marginTop: 12 }}
          disabled={!confirmed}
          onClick={() => setStep('verify')}
        >
          Verify backup
        </Button>
      </BackupModal>
    );

  return (
    <BackupModal title="Verify backup" onClose={onCancel}>
      <StepIndicator current={2} />
      <p style={{ fontSize: 17, color: colors.muted, marginBottom: 20 }}>
        Enter the words at the positions below to confirm you wrote them down.
      </p>
      {positions.map(pos => (
        <div key={pos} style={{ marginBottom: 12 }}>
          <Label>Word #{pos + 1}</Label>
          <Input
            value={answers[pos] ?? ''}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={e => setAnswers(p => ({ ...p, [pos]: e.target.value }))}
          />
        </div>
      ))}
      {err && <p style={{ color: colors.red, fontSize: 17 }}>{err}</p>}
      <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
        <Button variant="ghost" onClick={() => { setErr(null); setStep('show'); }}>
          Back to phrase
        </Button>
        <Button style={{ flex: 1 }} onClick={verify}>
          Confirm
        </Button>
      </div>
    </BackupModal>
  );
}
