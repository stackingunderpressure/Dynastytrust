import { useEffect, useRef, useState } from 'react';
import {
  startTapitConnectRequest, startTapitPubkeyConnectRequest, completeTapitCallback,
  rememberedTapitKey, rememberTapitKey,
  type TapitMode,
} from '../lib/wallet-signin';
import { subscribeSignInResponses } from '../lib/tapit-signin-response-channel';
import { Modal } from './ui/Modal';
import { Button, Input } from './ui';
import { QrImage } from './QrImage';
import { useToast } from './toast';
import { colors, fonts, space } from '../theme';

const XONLY_PUBKEY_RE = /^[0-9a-f]{64}$/i;

// Scan-to-connect: the QR encodes the exact same request URL
// prepareTapitFlow would otherwise redirect this tab to (tapit-wallet's
// existing /sign route, unchanged -- no new screen needed on that side).
// The difference is a response_channel field riding along in the request:
// Tapit's approveSignRequest sees it and publishes the signed grant back
// over Nostr instead of trying to redirect a browser tab nobody opened
// (mirrors the psbt-cosign response_channel pattern already proven for
// Cut B3). That's what lets this TAB stay open while a DIFFERENT device
// -- the phone with Tapit on it -- does the approving; a redirect could
// never do that, since scanning a QR opens a new browser context, not
// this one. "Open Tapit directly" below is the plain fallback for
// same-device use (desktop testing, or no camera handy) -- same URL, no
// scanning, and completeTapitCallback closes the loop identically either
// way once RequireAuth or this modal receives a grant.
//
// 2026-08-19 addition (operator: "every time it sends me to the tap
// wallet it's a completely new login screen even though the browser is
// logged in just fine... they're not PWAs on a home screen... I wanted a
// different way for DynastyTrust to join... a place to put the 64 digit
// public key from Tapit into there and then it can do all of the Nostr
// messaging back and forth after that"). "Open Tapit directly" is a
// full-page reload of tapit-wallet's own site, which re-triggers its
// local unlock gate on an already-open wallet -- indistinguishable from
// onboarding to someone who wasn't expecting it, and the QR needs a
// second device or a camera. Pasting the pubkey below delivers the exact
// same challenge directly over Nostr instead (startTapitPubkeyConnectRequest);
// tapit-wallet picks it up in its own already-open Inbox and never
// reloads the page at all. Runs ALONGSIDE the QR listener above, not
// instead of it -- both are just different delivery paths for the same
// challenge-response; whichever the person actually completes wins.
// 2026-11-27 (operator: "signing in with tapit to dynasty is broken. Not
// making the full round trip"; both are home-screen apps). On an iPhone a
// link never opens a home-screen app -- it opens a Safari tab with its own
// storage -- so "open Tapit" handed the request to a Tapit with no wallet,
// and the way back landed in Safari. The inbox route is the one that works
// between apps, so it now comes first, and this device remembers the Tapit
// key after it works once (docs/tapit-signin-inbox-build-note.md). The QR
// and the Safari link stay under "Other ways".
export function TapitConnectModal({ mode, onClose, onDone }: { mode: TapitMode; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  // The QR request (another device, or the Safari link) -- prepared in the background.
  const [qr, setQr] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; requestUrl: string; screenCode: string }
  >({ kind: 'loading' });
  const [finishing, setFinishing] = useState<{ kind: 'connecting' } | { kind: 'error'; message: string } | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const pubkeyCleanupRef = useRef<(() => void) | null>(null);

  const remembered = rememberedTapitKey();
  const [pubkeyInput, setPubkeyInput] = useState(remembered ?? '');
  const [sendingPubkey, setSendingPubkey] = useState(false);
  // The pushed request has its own challenge, so its own number (threat model G).
  const [pubkeySent, setPubkeySent] = useState<{ code: string; key: string } | null>(null);
  const [otherWays, setOtherWays] = useState(false);
  const autoSent = useRef(false);

  function finishWithGrant(grant: unknown, signerPubkey: string) {
    setFinishing({ kind: 'connecting' });
    void (async () => {
      try {
        const result = await completeTapitCallback({ mode, grant });
        rememberTapitKey(signerPubkey);
        toast.success(result.mode === 'link' ? 'Tapit wallet linked.' : result.mode === 'signup' ? 'Your account is made. Your Tapit wallet is how you sign in.' : 'Signed in with your Tapit wallet.');
        onDone();
      } catch (e) {
        setFinishing({ kind: 'error', message: e instanceof Error ? e.message : 'Could not complete sign-in' });
      }
    })();
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { requestUrl, replyPrivateKey, replyPublicKey, screenCode } = await startTapitConnectRequest(mode);
        if (cancelled) return;
        const { subscription, transport } = subscribeSignInResponses(
          replyPrivateKey,
          replyPublicKey,
          response => {
            if (!cancelled) finishWithGrant(response.grant, response.signerPubkey);
          },
        );
        cleanupRef.current = () => {
          subscription.close();
          transport.close();
        };
        setQr({ kind: 'ready', requestUrl, screenCode });
      } catch (e) {
        if (!cancelled) setQr({ kind: 'error', message: e instanceof Error ? e.message : 'Could not start' });
      }
    })();
    // A Tapit this device already knows: send straight to its inbox.
    if (remembered && !autoSent.current) {
      autoSent.current = true;
      void handlePubkeyConnect(remembered);
    }
    return () => {
      cancelled = true;
      cleanupRef.current?.();
      pubkeyCleanupRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function handlePubkeyConnect(key?: string) {
    const clean = (key ?? pubkeyInput).trim().toLowerCase();
    if (!XONLY_PUBKEY_RE.test(clean)) {
      toast.error("That doesn't look like a Tapit public key -- expected 64 hex characters.");
      return;
    }
    setSendingPubkey(true);
    try {
      pubkeyCleanupRef.current?.();
      const { replyPrivateKey, replyPublicKey, delivered, screenCode } = await startTapitPubkeyConnectRequest(mode, clean);
      const { subscription, transport } = subscribeSignInResponses(
        replyPrivateKey,
        replyPublicKey,
        response => {
          // Unlike the QR path (any real Tapit wallet answering the
          // challenge is legitimately the one connecting), this path names
          // a specific pubkey up front -- the reply pubkey is published in
          // the clear in the request event, so a forged response from a
          // DIFFERENT real Tapit wallet would otherwise silently link the
          // wrong identity to this account (Kimi K3 scan #146).
          if (response.signerPubkey.toLowerCase() !== clean) {
            toast.error("Received a connect response that wasn't signed by the pasted public key -- ignored.");
            return;
          }
          finishWithGrant(response.grant, clean);
        },
      );
      pubkeyCleanupRef.current = () => {
        subscription.close();
        transport.close();
      };
      setPubkeySent({ code: screenCode, key: clean });
      if (!delivered) {
        toast.error("Couldn't reach a relay just now -- the request is queued and will retry automatically. Keep this open.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send request');
    } finally {
      setSendingPubkey(false);
    }
  }

  function useDifferentTapit() {
    pubkeyCleanupRef.current?.();
    pubkeyCleanupRef.current = null;
    rememberTapitKey(null);
    setPubkeySent(null);
    setPubkeyInput('');
  }

  const title = mode === 'link' ? 'Connect Tapit wallet' : mode === 'signup' ? 'Create your account with Tapit' : 'Sign in with Tapit';
  const short = (k: string) => `${k.slice(0, 8)}...${k.slice(-6)}`;

  return (
    <Modal title={title} onClose={onClose}>
      {finishing?.kind === 'connecting' && <p style={{ color: colors.muted, fontSize: 17 }}>Approved -- finishing...</p>}
      {finishing?.kind === 'error' && (
        <>
          <p style={{ color: colors.red, fontSize: 17, marginBottom: 16 }}>{finishing.message}</p>
          <Button variant="ghost" onClick={onClose} style={{ minHeight: 44 }}>Close</Button>
        </>
      )}
      {!finishing && (
        <>
          {pubkeySent ? (
            <div>
              <ScreenNumber code={pubkeySent.code} />
              <p style={{ fontSize: 17, color: colors.sub, lineHeight: 1.6, textAlign: 'center', margin: '0 0 10px' }}>
                Sent to your Tapit (<span style={{ fontFamily: fonts.mono }}>{short(pubkeySent.key)}</span>). Open Tapit and approve it
                there -- it shows on Tapit's home screen and in its Inbox, and asks for this number. This screen finishes on its own.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', marginBottom: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors.gold }} />
                <span style={{ fontSize: 16, color: colors.muted }}>Waiting for approval...</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <Button variant="ghost" size="sm" style={{ minHeight: 44 }} disabled={sendingPubkey} onClick={() => void handlePubkeyConnect(pubkeySent.key)}>
                  {sendingPubkey ? 'Sending...' : 'Send again'}
                </Button>
                <Button variant="ghost" size="sm" style={{ minHeight: 44 }} onClick={useDifferentTapit}>
                  Use a different Tapit
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: 17, color: colors.sub, lineHeight: 1.6, margin: '0 0 10px' }}>
                Send this to your Tapit's inbox. Paste your Tapit public key -- in Tapit, Settings, Public key. This device remembers it
                after it works once.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Input
                  mono
                  value={pubkeyInput}
                  onChange={e => setPubkeyInput(e.target.value)}
                  placeholder="Tapit public key (64 characters)"
                  aria-label="Tapit public key"
                />
                <Button style={{ minHeight: 48, fontSize: 17 }} onClick={() => void handlePubkeyConnect()} disabled={sendingPubkey || !pubkeyInput.trim()}>
                  {sendingPubkey ? 'Sending...' : 'Send to my Tapit'}
                </Button>
              </div>
            </div>
          )}

          <div style={{ marginTop: 18, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}>
            <button
              type="button"
              onClick={() => setOtherWays(v => !v)}
              aria-expanded={otherWays}
              style={{ background: 'none', border: 'none', padding: '10px 0', minHeight: 44, fontSize: 16, color: colors.sub, textDecoration: 'underline', cursor: 'pointer' }}
            >
              {otherWays ? 'Hide other ways' : 'Other ways: scan a QR from another device, or open Tapit in Safari'}
            </button>
            {otherWays && qr.kind === 'loading' && <p style={{ color: colors.muted, fontSize: 17 }}>Preparing request...</p>}
            {otherWays && qr.kind === 'error' && <p style={{ color: colors.red, fontSize: 17 }}>{qr.message}</p>}
            {otherWays && qr.kind === 'ready' && (
              <>
                <div style={{ display: 'flex', justifyContent: 'center', margin: `${space[2]}px 0 ${space[3]}px` }}>
                  <QrImage data={qr.requestUrl} />
                </div>
                <ScreenNumber code={qr.screenCode} />
                <p style={{ fontSize: 16, color: colors.sub, textAlign: 'center', lineHeight: 1.6, marginBottom: 12 }}>
                  Scan with the phone your Tapit is on; approving there finishes here. This number goes with the QR.
                </p>
                <div style={{ textAlign: 'center' }}>
                  <a href={qr.requestUrl} onClick={onClose} style={{ fontSize: 16, color: colors.gold, fontFamily: fonts.sans }}>
                    Open Tapit in this browser instead
                  </a>
                  <p style={{ fontSize: 15, color: colors.muted, lineHeight: 1.5, margin: '6px 0 0' }}>
                    Only works when Tapit and DynastyTrust are both open in the same browser, not as home-screen apps.
                  </p>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

/** The two-digit sign-in number (threat model G): Tapit asks the person to type it. */
function ScreenNumber({ code }: { code: string }) {
  return (
    <div role="status" style={{ textAlign: 'center', marginBottom: space[3] }}>
      <div style={{ fontSize: 16, color: colors.sub }}>Your sign-in number</div>
      <div aria-label={`Sign-in number ${code.split('').join(' ')}`} style={{ fontFamily: fonts.mono, fontSize: 40, letterSpacing: '0.2em', color: colors.gold }}>{code}</div>
      <div style={{ fontSize: 15, color: colors.muted, lineHeight: 1.5 }}>Never type a number someone else gives you.</div>
    </div>
  );
}
