import { useEffect, useState } from 'react';
import { acceptFaceIdOffer, declineFaceIdOffer, forgetFaceIdSignIn, pendingFaceIdOffer, savedFaceIdSignIn, FACE_ID_SIGNIN_CHANGED } from '../lib/faceid-signin';
import { colors, radii, space } from '../theme';
import { Button } from './ui';
import { useToast } from './toast';

const box: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: space[2], padding: space[3], marginBottom: space[4], background: colors.surface, border: `1px solid ${colors.gold}55`, borderRadius: radii.md };
const sub: React.CSSProperties = { fontSize: 17, color: colors.sub, lineHeight: 1.6, margin: 0 };

/**
 * The one-time offer right after a password sign-in (operator: "user name
 * password with Face ID right after"). Lives at the top of every signed-in
 * page until answered; the password it would save is in memory only
 * (lib/faceid-signin.ts) and is gone after a reload.
 */
export function FaceIdSignInOffer() {
  const toast = useToast();
  const [offer, setOffer] = useState(() => pendingFaceIdOffer());
  const [busy, setBusy] = useState(false);
  if (!offer) return null;
  async function yes() {
    setBusy(true);
    try {
      await acceptFaceIdOffer();
      toast.success('Done. Next time, sign in with Face ID.');
      setOffer(null);
    } catch (e) {
      toast.error((e instanceof Error ? e.message : 'Face ID did not work') + ' You can still sign in with your password.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={box}>
      <p style={{ ...sub, color: colors.text, fontWeight: 600 }}>Sign in with Face ID next time?</p>
      <p style={sub}>
        Your password stays on this phone, locked so only your face (or fingerprint) can open it. Your phone asks two or
        three times now to prove it works. Keep your password written down too: Face ID is only on this phone.
      </p>
      <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap' }}>
        <Button style={{ minHeight: 44, flex: 1 }} disabled={busy} onClick={() => void yes()}>{busy ? 'Waiting for Face ID...' : 'Use Face ID'}</Button>
        <Button variant="ghost" style={{ minHeight: 44 }} disabled={busy} onClick={() => { declineFaceIdOffer(); setOffer(null); }}>Not now</Button>
      </div>
    </div>
  );
}

/** On the Keys page: is Face ID sign-in on for this phone, and turn it off. */
export function FaceIdSignInSetting() {
  const [saved, setSaved] = useState(() => savedFaceIdSignIn());
  useEffect(() => {
    const on = () => setSaved(savedFaceIdSignIn());
    window.addEventListener(FACE_ID_SIGNIN_CHANGED, on);
    return () => window.removeEventListener(FACE_ID_SIGNIN_CHANGED, on);
  }, []);
  if (!saved) return null;
  return (
    <div style={box}>
      <p style={{ ...sub, color: colors.text, fontWeight: 600 }}>Face ID sign-in on this phone</p>
      <p style={sub}>On for {saved.label}. Turning it off deletes the locked copy of your password from this phone.</p>
      <Button variant="ghost" style={{ minHeight: 44 }} onClick={() => forgetFaceIdSignIn()}>Turn off Face ID sign-in</Button>
    </div>
  );
}
