import { useState } from 'react';
import { generateSoftwareKey, type LocalKey } from '../lib/keystore';
import { createAccountWithWords, signInKeyOnThisPhone, signInWithThisPhone, signInWithWords } from '../lib/key-account';
import { BackupFlow } from './vault-builder/BackupFlow';
import { colors, radii, space } from '../theme';
import { Button, Input, Label, Textarea } from './ui';
import { usePrompt } from './dialog';

/**
 * No email: your key is your account (docs/key-signin-build-note.md).
 * Operator, 2026-11-13: "never have an email and only sign in with your
 * key ... you create one there with a password and face lock and then that
 * is your sign in".
 *
 * Three ways in, all on the sign-in page:
 *  - this phone already holds the account's words: one tap (Face ID, or
 *    the key's password when it has no Face ID lock);
 *  - new: choose a name and a password, write down and check the 24 words,
 *    lock them with Face ID -- only THEN is the account made, so nobody
 *    ends up with an account whose words were never written down;
 *  - another phone or a cleared browser: type the 24 words.
 * Hardware wallet sign-in is the next slice.
 */
export function KeySignIn() {
  const onPhone = signInKeyOnThisPhone();
  const askPassword = usePrompt();
  const [mode, setMode] = useState<'menu' | 'create' | 'words'>('menu');
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [words, setWords] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<{ key: LocalKey; mnemonic: string } | null>(null);

  const sub: React.CSSProperties = { fontSize: 17, color: colors.sub, lineHeight: 1.6, margin: 0 };
  const run = async (f: () => Promise<void>) => {
    setErr(null); setBusy(true);
    try { await f(); } catch (e) { setErr(e instanceof Error ? e.message : 'That did not work'); } finally { setBusy(false); }
  };

  async function phone() {
    await run(async () => {
      let password: string | undefined;
      if (onPhone && !onPhone.passkeyMnemonic && !onPhone.testMnemonic) {
        const typed = await askPassword({ title: 'Sign in', message: `Enter the password for "${onPhone.label}".`, password: true, confirmLabel: 'Sign in' });
        if (!typed) return;
        password = typed;
      }
      await signInWithThisPhone(password);
    });
  }

  async function startCreate(e: React.FormEvent) {
    e.preventDefault();
    if (pw !== pw2) { setErr('The two passwords are not the same.'); return; }
    await run(async () => {
      const r = await generateSoftwareKey({ label: 'My key', network: 'mainnet', password: pw, persona: name.trim() || 'Me' });
      setMade(r);
    });
  }

  async function finishCreate() {
    if (!made) return;
    await run(async () => {
      await createAccountWithWords(made.key.keyId, made.mnemonic, name);
      setMade(null);
    });
  }

  async function fromWords(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => { await signInWithWords(words, pw || undefined); });
  }

  if (made) {
    return (
      <BackupFlow
        keyData={made.key}
        mnemonic={made.mnemonic}
        onDone={() => void finishCreate()}
        onCancel={() => { setMade(null); setErr('Your account is not made until your 24 words are written down and checked. Start again when you are ready; the key stays on this phone under My key.'); }}
      />
    );
  }

  const box: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: space[2], padding: space[3], border: `1px solid ${colors.border}`, borderRadius: radii.md, background: colors.surface };

  return (
    <div style={box}>
      <p style={{ ...sub, color: colors.text, fontWeight: 600 }}>No email? Your key is your account</p>

      {mode === 'menu' && (
        <>
          {onPhone && (
            <Button style={{ minHeight: 44 }} disabled={busy} onClick={() => void phone()}>
              {busy ? 'Waiting for Face ID...' : onPhone.passkeyMnemonic ? 'Sign in with Face ID' : 'Sign in with this phone\'s key'}
            </Button>
          )}
          <Button variant={onPhone ? 'ghost' : 'primary'} style={{ minHeight: 44 }} disabled={busy} onClick={() => { setErr(null); setMode('create'); }}>
            Create an account with a key
          </Button>
          <Button variant="ghost" style={{ minHeight: 44 }} disabled={busy} onClick={() => { setErr(null); setMode('words'); }}>
            Sign in with my 24 words
          </Button>
          <p style={{ ...sub, fontSize: 16 }}>
            No email address, ever. Your 24 words are your account: write them down and keep them safe, because without
            them a lost phone means a lost account. Money in a vault stays safe either way.
          </p>
        </>
      )}

      {mode === 'create' && (
        <form onSubmit={e => void startCreate(e)} style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
          <p style={sub}>
            Your phone makes a new key. You will write down its 24 words and check them, then lock it with Face ID.
            The words are your account and your first vault key.
          </p>
          <div><Label>Your name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="What the family calls you" maxLength={40} required /></div>
          <div><Label>Password for this key</Label><Input type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" required /></div>
          <div><Label>Password again</Label><Input type="password" value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" required /></div>
          <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap' }}>
            <Button type="button" variant="ghost" style={{ minHeight: 44 }} onClick={() => { setErr(null); setMode('menu'); }}>Back</Button>
            <Button type="submit" style={{ minHeight: 44, flex: 1 }} disabled={busy}>{busy ? 'Making your key...' : 'Make my key'}</Button>
          </div>
        </form>
      )}

      {mode === 'words' && (
        <form onSubmit={e => void fromWords(e)} style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
          <div>
            <Label>Your 24 words</Label>
            <Textarea rows={4} value={words} onChange={e => setWords(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="word1 word2 word3 ..." />
          </div>
          <div>
            <Label>Keep it on this phone (optional)</Label>
            <Input type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" placeholder="A password, to sign in with one tap next time" />
          </div>
          <p style={{ ...sub, fontSize: 16 }}>Leave the password empty on a phone that is not yours: nothing is kept.</p>
          <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap' }}>
            <Button type="button" variant="ghost" style={{ minHeight: 44 }} onClick={() => { setErr(null); setMode('menu'); }}>Back</Button>
            <Button type="submit" style={{ minHeight: 44, flex: 1 }} disabled={busy || !words.trim()}>{busy ? 'Signing in...' : 'Sign in'}</Button>
          </div>
        </form>
      )}

      {err && <p style={{ ...sub, color: colors.red }}>{err}</p>}
    </div>
  );
}
