import { useEffect, useRef, useState } from 'react';
import {
  startTapitConnectRequest, completeTapitCallback,
  type TapitMode,
} from '../lib/wallet-signin';
import { subscribeSignInResponses } from '../lib/tapit-signin-response-channel';
import { Modal } from './ui/Modal';
import { Button } from './ui';
import { QrImage } from './QrImage';
import { useToast } from './toast';
import { colors, fonts, space } from '../theme';

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
export function TapitConnectModal({ mode, onClose, onDone }: { mode: TapitMode; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'waiting'; requestUrl: string }
    | { kind: 'connecting' }
  >({ kind: 'loading' });
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { requestUrl, replyPrivateKey, replyPublicKey } = await startTapitConnectRequest(mode);
        if (cancelled) return;
        const { subscription, transport } = subscribeSignInResponses(
          replyPrivateKey,
          replyPublicKey,
          async response => {
            if (cancelled) return;
            setState({ kind: 'connecting' });
            try {
              const result = await completeTapitCallback({ mode, grant: response.grant });
              toast.success(result.mode === 'link' ? 'Tapit wallet linked.' : 'Signed in with your Tapit wallet.');
              onDone();
            } catch (e) {
              if (!cancelled) setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not complete sign-in' });
            }
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

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
        </>
      )}
    </Modal>
  );
}
