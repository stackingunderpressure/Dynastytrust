import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { UR, UREncoder } from '@gandlaf21/bc-ur';
import { colors, fonts, radii } from '../theme';

/**
 * Animated UR-encoded PSBT QR. Splits the binary PSBT into UR
 * fragments and cycles them at ~150 ms each so air-gapped wallets
 * (Coldcard Q, Jade, Passport, Foundation) can scan the whole
 * payload without USB or paste. The encoder is stateless -- each
 * fragment is self-describing, so the scanning device reassembles
 * with no pairing.
 *
 * Uses UR `crypto-psbt` registry type (Bitcoin Core / Sparrow / BCR
 * convention).
 */

interface PsbtQrDisplayProps {
  /** PSBT as hex string. */
  psbtHex: string;
  /** Pixels per side for the QR. */
  size?: number;
  /** Max bytes per fragment (smaller = more readable but more frames). */
  fragmentLength?: number;
  /** Frame interval in ms. ~150 is comfortable for most cameras. */
  intervalMs?: number;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function PsbtQrDisplay({
  psbtHex,
  size = 280,
  fragmentLength = 200,
  intervalMs = 150,
}: PsbtQrDisplayProps) {
  const encoderRef = useRef<UREncoder | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [totalFragments, setTotalFragments] = useState(0);
  const [paused, setPaused] = useState(false);

  // Build the UR encoder once per PSBT.
  useEffect(() => {
    try {
      const bytes = hexToBytes(psbtHex);
      const ur = UR.fromBuffer(Buffer.from(bytes));
      const enc = new UREncoder(ur, fragmentLength, 0, 8);
      encoderRef.current = enc;
      setTotalFragments(enc.fragmentsLength);
      setFrame(0);
    } catch {
      encoderRef.current = null;
    }
  }, [psbtHex, fragmentLength]);

  // Tick: render the next UR fragment as a QR image.
  useEffect(() => {
    if (paused || !encoderRef.current) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || !encoderRef.current) return;
      const part = encoderRef.current.nextPart();
      try {
        const url = await QRCode.toDataURL(part.toUpperCase(), {
          width: size,
          margin: 2,
          errorCorrectionLevel: 'M',
          color: { dark: '#E8E4D8', light: '#07070F' },
        });
        if (!cancelled) {
          setSrc(url);
          setFrame(f => (totalFragments > 0 ? (f + 1) % Math.max(totalFragments, 1) : f + 1));
        }
      } catch {
        /* skip frame */
      }
    };
    void tick();
    const iv = window.setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [paused, intervalMs, size, totalFragments]);

  if (!src) {
    return (
      <div
        style={{
          width: size,
          height: size,
          background: colors.input,
          borderRadius: 8,
        }}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <img
        src={src}
        alt="PSBT QR"
        width={size}
        height={size}
        style={{ borderRadius: 8, display: 'block' }}
      />
      <div style={{ fontSize: 11, color: colors.muted, fontFamily: fonts.mono }}>
        {totalFragments > 1
          ? `frame ${(frame % totalFragments) + 1} of ${totalFragments}`
          : 'single QR'}
      </div>
      <button
        type="button"
        onClick={() => setPaused(p => !p)}
        style={{
          padding: '4px 12px',
          fontSize: 11,
          background: 'none',
          border: `1px solid ${colors.border}`,
          borderRadius: radii.md,
          color: colors.sub,
          cursor: 'pointer',
          fontFamily: fonts.sans,
        }}
      >
        {paused ? 'Resume' : 'Pause'}
      </button>
    </div>
  );
}
