import { useRef, useState } from 'react';
import { URDecoder } from '@gandlaf21/bc-ur';
import { colors, fonts, radii } from '../theme';
import { Button } from './ui';
import { useQrCameraLoop } from './useQrCameraLoop';
import { QrScanStatus } from './QrScanStatus';

/**
 * Multi-fragment UR QR scanner. Designed for the inverse of
 * PsbtQrDisplay: receives an animated QR sequence from an
 * air-gapped signer (Coldcard Q, Jade, Passport) and reassembles
 * the signed PSBT. Stateless on both sides -- the decoder figures
 * out the message from the fragments themselves.
 *
 * Supports plain QR too: if the scanner reads a non-UR string that
 * decodes as base64 or hex PSBT, it fires onResult immediately
 * without going through the UR decoder.
 */

interface PsbtQrScannerProps {
  /** Called once a complete PSBT has been reassembled. */
  onResult: (psbtHex: string) => void;
  onCancel?: () => void;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function looksLikePsbtMagic(hex: string): boolean {
  return hex.toLowerCase().startsWith('70736274ff');
}

export function PsbtQrScanner({ onResult, onCancel }: PsbtQrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const decoderRef = useRef<URDecoder>(new URDecoder());
  const seenRef = useRef<Set<string>>(new Set());
  const [scanError, setScanError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [received, setReceived] = useState(0);
  const [expected, setExpected] = useState(0);

  function handleScan(text: string): boolean {
    if (!text) return false;
    // Plain PSBT path: if the QR contains a hex/base64 PSBT
    // directly (single QR, common with smaller PSBTs), shortcut.
    const lower = text.toLowerCase();
    if (looksLikePsbtMagic(lower)) {
      onResult(lower.replace(/\s+/g, ''));
      return true;
    }
    try {
      const decoded = atob(text.trim());
      let hex = '';
      for (let i = 0; i < decoded.length; i++) {
        hex += decoded.charCodeAt(i).toString(16).padStart(2, '0');
      }
      if (looksLikePsbtMagic(hex)) {
        onResult(hex);
        return true;
      }
    } catch { /* not base64, fall through to UR */ }

    // UR multi-fragment path.
    if (!text.toLowerCase().startsWith('ur:')) return false;
    // Skip duplicate fragments to avoid wasting decoder cycles.
    if (seenRef.current.has(text)) return false;
    seenRef.current.add(text);
    const dec = decoderRef.current;
    try {
      dec.receivePart(text);
      const est = (dec.expectedPartCount?.() ?? 0) || 0;
      const got = dec.receivedPartIndexes?.()?.length ?? 0;
      setExpected(est);
      setReceived(got);
      setProgress(dec.estimatedPercentComplete?.() ?? 0);
      if (dec.isComplete()) {
        if (dec.isSuccess()) {
          const ur = dec.resultUR();
          const decoded = ur.decodeCBOR();
          const buf: Uint8Array = decoded instanceof Uint8Array
            ? decoded
            : new Uint8Array(decoded);
          const hex = bytesToHex(buf);
          if (looksLikePsbtMagic(hex)) {
            onResult(hex);
            return true;
          }
          setScanError("UR decoded but didn't look like a PSBT.");
        } else {
          setScanError("UR scan failed -- try again.");
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

  const { error: cameraError, scanning, elapsedMs } = useQrCameraLoop(videoRef, handleScan);
  const error = cameraError ?? scanError;

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
        </div>
      )}
      {expected > 0 && (
        <div style={{ fontSize: 12, color: colors.muted, textAlign: 'center', fontFamily: fonts.mono }}>
          {received} of {expected} fragments received ({Math.round(progress * 100)}%)
        </div>
      )}
      {scanning && !error && expected === 0 && <QrScanStatus elapsedMs={elapsedMs} />}
      {onCancel && (
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}
