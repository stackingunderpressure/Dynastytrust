import { useEffect, useRef, useState } from 'react';
import {
  startTapitConnectRequest, startTapitPubkeyConnectRequest, completeTapitCallback,
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
// startTapitFlow would otherwise redirect this tab to (tapit-wallet's
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
export function TapitConnectModal({ mode, onClose, onDone }: { mode: TapitMode; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'waiting'; requestUrl: string }
    | { kind: 'connecting' }
  >({ kind: 'loading' });
  const cleanupRef = useRef<(() => void) | null>(null);
  const pubkeyCleanupRef = useRef<(() => void) | null>(null);

  const [pubkeyInput, setPubkeyInput] = useState('');
  const [sendingPubkey, setSendingPubkey] = useState(false);
  const [pubkeySent, setPubkeySent] = useState(false);

  function finishWithGrant(grant: unknown) {
    setState({ kind: 'connecting' });
    void (async () => {
      try {
        const result = await completeTapitCallback({ mode, grant });
        toast.success(result.mode === 'link' ? 'Tapit wallet linked.' : 'Signed in with your Tapit wallet.');
        onDone();
      } catch (e) {
        setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not complete sign-in' });
      }
    })();
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { requestUrl, replyPrivateKey, replyPublicKey } = await startTapitConnectRequest(mode);
        if (cancelled) return;
        const { subscription, transport } = subscribeSignInResponses(
          replyPrivateKey,
          replyPublicKey,
          response => {
            if (!cancelled) finishWithGrant(response.grant);
          },
        );
        cleanupRef.current = () => {
          subscription.close();
          transport.close();
        };
        setState({ kind: 'waiting', requestUrl });
      } catch (e) {
        if (!cancelled) setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not start' });
      }
    })();
    return () => {
      cancelled = true;
      cleanupRef.current?.();
      pubkeyCleanupRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function handlePubkeyConnect() {
    const clean = pubkeyInput.trim().toLowerCase();
    if (!XONLY_PUBKEY_RE.test(clean)) {
      toast.error("That doesn't look like a Tapit public key -- expected 64 hex characters.");
      return;
    }
    setSendingPubkey(true);
    try {
      const { replyPrivateKey, replyPublicKey, delivered } = await startTapitPubkeyConnectRequest(mode, clean);
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
          finishWithGrant(response.grant);
        },
      );
      pubkeyCleanupRef.current = () => {
        subscription.close();
        transport.close();
      };
      setPubkeySent(true);
      if (!delivered) {
        toast.error("Couldn't reach a relay just now -- the request is queued and will retry automatically. Keep this open.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send request');
    } finally {
      setSendingPubkey(false);
    }
  }

  return (
    <Modal title="Connect Tapit wallet" onClose={onClose}>
      {state.kind === 'loading' && <p style={{ color: colors.muted, fontSize: 14 }}>Preparing request...</p>}
      {state.kind === 'error' && (
        <>
          <p style={{ color: colors.red, fontSize: 14, marginBottom: 16 }}>{state.message}</p>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </>
      )}
      {state.kind === 'connecting' && <p style={{ color: colors.muted, fontSize: 14 }}>Connecting...</p>}
      {state.kind === 'waiting' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: space[3] }}>
            <QrImage data={state.requestUrl} />
          </div>
          <p style={{ fontSize: 13, color: colors.sub, textAlign: 'center', lineHeight: 1.6, marginBottom: 12 }}>
            Scan this with the phone your Tapit wallet is on. Approving there signs you in here
            automatically -- this tab does not need to redirect anywhere.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', marginBottom: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors.gold }} />
            <span style={{ fontSize: 12, color: colors.muted }}>Waiting for approval...</span>
          </div>
          <div style={{ textAlign: 'center', marginTop: 16, paddingTop: 16, borderTop: `1px solid ${colors.border}` }}>
            <a
              href={state.requestUrl}
              onClick={onClose}
              style={{ fontSize: 12, color: colors.gold, fontFamily: fonts.sans }}
            >
              Or open Tapit directly on this device
            </a>
          </div>

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${colors.border}` }}>
            <p style={{ fontSize: 12, color: colors.muted, marginBottom: 8, textAlign: 'center' }}>
              Wallet already open on this device? Skip the QR -- paste its public key instead.
            </p>
            {pubkeySent ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors.gold }} />
                <span style={{ fontSize: 12, color: colors.muted }}>
                  Sent -- check your Tapit wallet's Inbox to approve.
                </span>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <Input
                  mono
                  value={pubkeyInput}
                  onChange={e => setPubkeyInput(e.target.value)}
                  placeholder="Tapit public key (64 hex characters)"
                  style={{ flex: 1 }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handlePubkeyConnect}
                  disabled={sendingPubkey || !pubkeyInput.trim()}
                >
                  {sendingPubkey ? 'Sending...' : 'Send'}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
