import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { URDecoder } from '@gandlaf21/bc-ur';
import { parseHardwareWalletExport } from '../lib/keystore';
import { colors, fonts, radii } from '../theme';
import { Button } from './ui';

/**
 * Camera QR scanner for importing an xpub from a hardware signer
 * (SeedSigner, Coldcard, etc.) -- the inverse of typing a 100+
 * character extended pubkey and a derivation path on a phone keyboard.
 * Same camera-loop mechanics as PsbtQrScanner (getUserMedia + jsQR +
 * requestAnimationFrame), adapted for what a signer's xpub/wallet
 * export QR actually contains rather than a PSBT.
 *
 * Handles, per frame:
 *   1. A bare xpub/tpub/etc. string -- some signers show just the key
 *      itself as the QR, nothing else. Fires with path === null so the
 *      caller knows to leave its derivation-path field exactly as it
 *      was (whatever sensible default was already showing), instead of
 *      blanking a field this scan has no information about.
 *   2. JSON text (single QR or reassembled from a UR sequence) --
 *      reuses parseHardwareWalletExport, the same parser the file-
 *      import path already uses, so a signer that puts its file-export
 *      JSON into a QR instead of (or in addition to) a file works too.
 *   3. Anything else UR-encoded that ISN'T JSON once decoded (a real
 *      BCR crypto-hdkey/crypto-account CBOR payload) is deliberately
 *      NOT hand-parsed -- getting key-derivation metadata wrong is a
 *      worse failure than not supporting a format yet, so this surfaces
 *      an honest error instead of guessing at an unfamiliar binary
 *      encoding of key material.
 */

interface XpubQrScannerProps {
  /** path is null when the scan only found a bare xpub -- the caller
   *  should leave its own derivation-path field untouched rather than
   *  overwrite it with information this scan doesn't have. */
  onResult: (xpub: string, path: string | null) => void;
  onCancel?: () => void;
}

function looksLikeXpub(text: string): boolean {
  return /^[a-zA-Z]pub[a-zA-Z0-9]{80,}$/.test(text.trim());
}

export function XpubQrScanner({ onResult, onCancel }: XpubQrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const decoderRef = useRef<URDecoder | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [received, setReceived] = useState(0);
  const [expected, setExpected] = useState(0);

  useEffect(() => {
    decoderRef.current = new URDecoder();
    seenRef.current = new Set();
    let cancelled = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Camera access isn't supported in this browser.");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        tick();
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Could not access the camera. Check permissions.',
        );
      }
    }

    function tryJson(text: string): boolean {
      try {
        const parsed = parseHardwareWalletExport(JSON.parse(text));
        if (parsed) {
          onResult(parsed.xpub, parsed.path);
          return true;
        }
      } catch { /* not JSON */ }
      return false;
    }

    function handleScan(text: string): boolean {
      if (!text) return false;
      const trimmed = text.trim();

      if (looksLikeXpub(trimmed)) {
        onResult(trimmed, null);
        return true;
      }
      if (tryJson(trimmed)) return true;

      if (!trimmed.toLowerCase().startsWith('ur:')) return false;
      if (seenRef.current.has(trimmed)) return false;
      seenRef.current.add(trimmed);
      const dec = decoderRef.current;
      if (!dec) return false;
      try {
        dec.receivePart(trimmed);
        const est = (dec.expectedPartCount?.() ?? 0) || 0;
        const got = dec.receivedPartIndexes?.()?.size ?? 0;
        setExpected(est);
        setReceived(got);
        setProgress(dec.estimatedPercentComplete?.() ?? 0);
        if (dec.isComplete()) {
          if (dec.isSuccess()) {
            const ur = dec.resultUR();
            const decoded = ur.decodeCBOR();
            const buf: Uint8Array = decoded instanceof Uint8Array ? decoded : new Uint8Array(decoded);
            const asText = new TextDecoder().decode(buf);
            if (tryJson(asText)) return true;
            setError(
              `Scanned a "${ur.type}" QR this app doesn't parse yet -- use the file or paste-in import instead.`,
            );
          } else {
            setError('QR scan failed -- try again.');
            decoderRef.current = new URDecoder();
            seenRef.current = new Set();
            setProgress(0);
            setReceived(0);
            setExpected(0);
          }
        }
      } catch {
        /* malformed fragment, ignore */
      }
      return false;
    }

    function tick() {
      if (cancelled) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w && h) {
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(video, 0, 0, w, h);
            const img = ctx.getImageData(0, 0, w, h);
            const code = jsQR(img.data, img.width, img.height);
            if (code?.data) {
              const done = handleScan(code.data);
              if (done) return;
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    void start();
    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [onResult]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {error ? (
        <div
          style={{
            padding: '12px 14px',
            background: colors.dangerBg,
            border: `1px solid ${colors.borderDanger}`,
            borderRadius: radii.md,
            color: colors.red,
            fontSize: 13,
            fontFamily: fonts.sans,
          }}
        >
          {error}
        </div>
      ) : (
        <div
          style={{
            position: 'relative',
            width: '100%',
            maxWidth: 320,
            aspectRatio: '1 / 1',
            margin: '0 auto',
            borderRadius: radii.md,
            overflow: 'hidden',
            border: `1px solid ${colors.border}`,
            background: '#000',
          }}
        >
          <video
            ref={videoRef}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            playsInline
            muted
          />
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </div>
      )}
      {expected > 0 && (
        <div style={{ fontSize: 12, color: colors.muted, textAlign: 'center', fontFamily: fonts.mono }}>
          {received} of {expected} fragments received ({Math.round(progress * 100)}%)
        </div>
      )}
      {onCancel && (
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}
