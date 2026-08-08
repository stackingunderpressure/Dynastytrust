import { useState } from 'react';
import { markBackedUp, type LocalKey } from '../../lib/keystore';
import { colors, fonts, radii, space } from '../../theme';
import { Button, Input, Label } from '../ui';

// Self-contained modal shell used only by BackupFlow below. Deliberately
// NOT the shared components/ui/Modal.tsx -- this one is intentionally
// non-dismissible (onClose is a no-op from the caller) so a user can't
// tap-away out of the mandatory backup-and-verify gate mid-flow. Ported
// as-is from KeyManager.tsx rather than switched to the shared Modal, to
// keep this extraction behavior-faithful.
export function BackupModal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
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
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          padding: '28px 32px',
          width: '100%',
          maxWidth: wide ? 660 : 520,
          maxHeight: '92vh',
          overflowY: 'auto',
          fontFamily: fonts.sans,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, color: colors.text, fontFamily: fonts.display, margin: 0 }}>
            {title}
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: colors.muted, fontSize: 18, cursor: 'pointer' }}>
            x
          </button>
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
        <Button variant="ghost" size="sm" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setVis(v => !v)}>
          {vis ? 'Hide' : 'Reveal words'}
        </Button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 5 }}>
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
            <span style={{ fontSize: 10, color: colors.muted, minWidth: 16, flexShrink: 0 }}>{i + 1}</span>
            <span
              style={{
                fontSize: 12,
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
      {vis && (
        <Button
          variant="ghost"
          size="sm"
          style={{ width: '100%', marginTop: 10, fontSize: 12 }}
          onClick={() => navigator.clipboard.writeText(words.join(' '))}
        >
          Copy all 24 words
        </Button>
      )}
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
                fontSize: 11,
                fontWeight: 700,
                background: active || done ? colors.gold : colors.raised,
                color: active || done ? colors.bg : colors.muted,
              }}
            >
              {n}
            </span>
            <span style={{ fontSize: 12, color: active ? colors.text : colors.muted }}>
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
        <p style={{ fontSize: 13, color: colors.green, margin: 0 }}>
          <strong>{keyData.label}</strong> is ready to use in the vault. Its recovery phrase is below -- tap "Reveal
          words" to see it.
        </p>
      </div>
      <WordGrid words={mnemonic.split(' ')} />
      <p style={{ fontSize: 12, color: colors.muted, marginTop: 12, marginBottom: 0 }}>
        Backing it up now means writing all 24 words down and confirming a few of them. You can also do this later --
        the key works in the vault either way, and it'll be flagged "not backed up" until you do.
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
// Non-dismissible by design once entered (onClose props above are no-ops)
// -- someone who chose to back up now shouldn't be able to tap-away
// mid-ritual and end up thinking they're covered when they're not.
export function BackupFlow({ keyData, mnemonic, onDone }: { keyData: LocalKey; mnemonic: string; onDone: () => void }) {
  const words = mnemonic.split(' ');
  const [step, setStep] = useState<'show' | 'verify'>('show');
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
    onDone();
  }

  if (step === 'show')
    return (
      <BackupModal title="Write down your recovery phrase" onClose={() => {}} wide>
        <StepIndicator current={1} />
        <div style={{ padding: '10px 14px', background: colors.dangerBg, border: `1px solid ${colors.borderDanger}`, borderRadius: radii.md, marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: colors.red, margin: 0 }}>
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
          <span style={{ fontSize: 13, color: colors.sub }}>I have written all 24 words in order.</span>
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
    <BackupModal title="Verify backup" onClose={() => {}}>
      <StepIndicator current={2} />
      <p style={{ fontSize: 13, color: colors.muted, marginBottom: 20 }}>
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
      {err && <p style={{ color: colors.red, fontSize: 13 }}>{err}</p>}
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
