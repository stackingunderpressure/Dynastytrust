import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Buffer } from 'buffer';
import { encode as cborEncode } from 'cborg';
import { UR, UREncoder } from '@gandlaf21/bc-ur';
import * as btc from '@scure/btc-signer';
import { sha256 } from '@noble/hashes/sha256';
import { colors, fonts, radii } from '../theme';

/**
 * A short, deterministic fingerprint of exactly which transaction is
 * about to be signed -- meant to be compared, digit by digit, against
 * the same value SeedSigner (or any other air-gapped signer) shows on
 * its own screen before trusting anything else there. Operator, on a
 * vault with a lot of leaves and a small signer screen: "the first few
 * digits of the hash of the transaction you're signing and then the
 * coordinator has that same hash on its screen... as long as the hash
 * is the same... there's no way they can fake the wrong hash."
 *
 * The fingerprint is the standard Bitcoin txid -- double-SHA256 over
 * version/inputs/outputs/locktime, byte-reversed for display -- which
 * deliberately excludes witness data. That's exactly why it works as a
 * cross-device check for this app's Taproot-only vaults: a signature
 * only ever lives in the witness, so this hash is identical whether
 * zero, some, or all required signatures are present yet.
 * Cross-checked byte-for-byte against SeedSigner's own embit-based
 * computation (Transaction.txid()) on a real PSBT -- same algorithm,
 * same result, independent of which library computes it.
 *
 * Uses Transaction.unsignedTx, not the .id getter -- .id throws
 * ("Transaction is not finalized") for anything short of a fully
 * signed PSBT, which is every PSBT this component is ever asked to
 * display (its whole job is showing an UNSIGNED or partially-signed
 * one for someone to go sign).
 *
 * What a match proves: this signer parsed byte-for-byte the same
 * transaction shown here -- catches a corrupted QR transfer, a stale
 * cached frame, or a swapped-in different proposal. What it does NOT
 * prove: that the transaction is honest -- a compromised coordinator
 * could show a fake amount/destination on ITS OWN screen while sending
 * the real transaction here, and the fingerprint would still match,
 * since both sides would be hashing the same (malicious) bytes. This
 * is a fast supplementary check, never a substitute for reading the
 * real amounts and addresses SeedSigner's own review screens show.
 */
export function psbtTransactionFingerprint(psbtHex: string): string | null {
  try {
    const bytes = hexToBytes(psbtHex);
    const tx = btc.Transaction.fromPSBT(bytes, { allowUnknownOutputs: true, allowLegacyWitnessUtxo: true });
    const hash = sha256(sha256(tx.unsignedTx));
    const reversed = Uint8Array.from(hash).reverse();
    const hex = Array.from(reversed).map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8);
  } catch {
    return null;
  }
}

/**
 * Animated UR-encoded PSBT QR. Splits the binary PSBT into UR
 * fragments and cycles them so air-gapped wallets (Coldcard Q, Jade,
 * Passport, Foundation, SeedSigner) can scan the whole payload without
 * USB or paste. The encoder is stateless -- each fragment is
 * self-describing, so the scanning device reassembles with no pairing.
 *
 * Uses UR `crypto-psbt` registry type (Bitcoin Core / Sparrow / BCR
 * convention).
 *
 * Operator, 2026-08-11: "The seed signer will not scan the transaction
 * qr. it needs more display settings speed bright." Then, after the
 * fixes below still didn't work: "I cannot get it to even recognize it
 * at all... it's not the same format." That second report was correct
 * and pointed at the real, total blocker -- three real bugs found:
 *
 * (1) FORMAT (the actual blocker): `UR.fromBuffer(buf, 'crypto-psbt')`
 * looks like it takes a type argument, but @gandlaf21/bc-ur's actual
 * `UR.fromBuffer(buf: Buffer): UR` only accepts one parameter -- the
 * `'crypto-psbt'` argument was silently dropped and `UR`'s type
 * defaulted to `'bytes'`. Every fragment this component ever rendered
 * was `UR:BYTES/1-9/...`, never `UR:CRYPTO-PSBT/1-9/...`. SeedSigner's
 * decode_qr.py classifies a scan as a PSBT UR2 by regex-matching the
 * literal prefix `^UR:CRYPTO-PSBT/` (case-insensitive) -- a `bytes`-typed
 * UR never matches that, so SeedSigner never even attempted to decode
 * it as a PSBT. This is why brightness/speed changes made no
 * difference: the device wasn't failing to read the code, it was
 * correctly refusing to recognize a code that was never actually typed
 * as a PSBT. Fixed by building the UR through its public constructor
 * (`new UR(cborPayload, 'crypto-psbt')`) with the CBOR payload encoded
 * via `cborg` directly -- the same library bc-ur's own (unexported)
 * `cborEncode` helper wraps internally -- instead of the broken
 * `fromBuffer` static method.
 *
 * (2) POLARITY: this rendered light-colored modules on a near-black
 * background to match the app's dark theme -- standard QR decoders
 * (SeedSigner's camera-side scanner included) are tuned for dark
 * modules on a light background. Fixed to always render true
 * black-on-white, inside a white card, regardless of page theme --
 * matching the fix Tapit Wallet's QrShow.tsx already proved necessary.
 *
 * (3) SPEED: the cycle speed was a hardcoded 150ms with no way to slow
 * it down for a specific device. Confirmed against SeedSigner's own
 * source (gui/screens/scan_screens.py): on Pi-Zero-class hardware it
 * deliberately targets just 5fps (~200ms/frame) for its whole capture
 * + decode + render pipeline. Presets below sit at and above that
 * ~200ms floor, with a visible Slow/Normal/Fast control.
 */

const SPEED_PRESETS = { slow: 500, normal: 300, fast: 180 } as const;
type Speed = keyof typeof SPEED_PRESETS;

interface PsbtQrDisplayProps {
  /** PSBT as hex string. */
  psbtHex: string;
  /** Pixels per side for the QR. Omit to size responsively -- see
   *  computeResponsiveSize below; an explicit value disables that. */
  size?: number;
  /** Max bytes per fragment (smaller = more readable but more frames). */
  fragmentLength?: number;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Fills nearly the whole viewport width so the QR is already as large as
// it can be without the operator having to pinch-zoom their own browser
// first. Operator, after finding that manually zooming in was the only
// way SeedSigner's camera would lock onto the code reliably: "blow up the
// QR code instead of me having to do it manually every time... don't
// make the user do that." Larger modules on screen are exactly why that
// worked -- see this file's SPEED section above on the low-res Pi camera
// -- so making that the DEFAULT, not a manual step, fixes the same root
// cause the zoom workaround was compensating for. Capped so it doesn't
// look absurd on a tablet or desktop; floored at the old static default
// so a narrow window never renders smaller than before.
function computeResponsiveSize(): number {
  if (typeof window === 'undefined') return 280;
  return Math.max(280, Math.min(window.innerWidth - 48, 480));
}

export function PsbtQrDisplay({
  psbtHex,
  size,
  fragmentLength = 200,
}: PsbtQrDisplayProps) {
  const encoderRef = useRef<UREncoder | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [totalFragments, setTotalFragments] = useState(0);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState<Speed>('normal');
  const intervalMs = SPEED_PRESETS[speed];
  const fingerprint = useMemo(() => psbtTransactionFingerprint(psbtHex), [psbtHex]);

  // Responsive by default (see computeResponsiveSize); an explicit `size`
  // prop always wins and disables the resize listener.
  const [renderSize, setRenderSize] = useState(() => size ?? computeResponsiveSize());
  useEffect(() => {
    if (size != null) { setRenderSize(size); return; }
    const onResize = () => setRenderSize(computeResponsiveSize());
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [size]);

  // Build the UR encoder once per PSBT.
  useEffect(() => {
    try {
      const bytes = hexToBytes(psbtHex);
      // UR.fromBuffer() ignores any type argument and always defaults
      // to 'bytes' -- see this file's header comment. Build the UR via
      // its public constructor instead, so the emitted fragments are
      // actually typed 'crypto-psbt'.
      const cborPayload = Buffer.from(cborEncode(Buffer.from(bytes)));
      const ur = new UR(cborPayload, 'crypto-psbt');
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
          width: renderSize,
          margin: 3,
          // 'L' (not 'M') keeps module density down -- fewer, larger
          // modules are easier for a low-resolution camera (SeedSigner's
          // Pi camera runs 512x384) to resolve distinctly. Fragment loss
          // from a lower correction level is fine; the animation just
          // re-cycles past it and the device catches it next lap.
          errorCorrectionLevel: 'L',
          // Standard black-on-white polarity, not the app's dark theme
          // colors -- see this file's header comment for why. Never
          // vary this with the page theme.
          color: { dark: '#000000', light: '#FFFFFF' },
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
  }, [paused, intervalMs, renderSize, totalFragments]);

  if (!src) {
    return (
      <div
        style={{
          width: renderSize,
          height: renderSize,
          background: colors.input,
          borderRadius: 8,
        }}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          background: '#FFFFFF',
          padding: 12,
          borderRadius: 8,
          lineHeight: 0,
        }}
      >
        <img
          src={src}
          alt="PSBT QR"
          width={renderSize}
          height={renderSize}
          style={{ display: 'block' }}
        />
      </div>
      <div style={{ fontSize: 11, color: colors.muted, fontFamily: fonts.mono }}>
        {totalFragments > 1
          ? `frame ${(frame % totalFragments) + 1} of ${totalFragments}`
          : 'single QR'}
      </div>
      {fingerprint && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            padding: '8px 14px',
            border: `1px solid ${colors.gold}`,
            borderRadius: radii.md,
            maxWidth: renderSize,
          }}
        >
          <span style={{ fontSize: 10, color: colors.muted, fontFamily: fonts.sans, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Transaction check
          </span>
          <span style={{ fontSize: 18, color: colors.gold, fontFamily: fonts.mono, letterSpacing: 2 }}>
            {fingerprint.slice(0, 4)} {fingerprint.slice(4, 8)}
          </span>
          <span style={{ fontSize: 10, color: colors.muted, fontFamily: fonts.sans, textAlign: 'center' }}>
            Compare this to what your signer shows before signing. A mismatch means
            don't trust the QR transfer -- rescan. A match only proves it's the same
            transaction -- still read the amount, address, and path on your signer.
          </span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: colors.muted, fontFamily: fonts.sans }}>Speed:</span>
        {(Object.keys(SPEED_PRESETS) as Speed[]).map(s => (
          <button
            key={s}
            type="button"
            onClick={() => setSpeed(s)}
            style={{
              padding: '4px 10px',
              fontSize: 11,
              background: speed === s ? colors.gold : 'none',
              border: `1px solid ${speed === s ? colors.gold : colors.border}`,
              borderRadius: radii.md,
              color: speed === s ? colors.bg : colors.sub,
              cursor: 'pointer',
              fontFamily: fonts.sans,
              textTransform: 'capitalize',
            }}
          >
            {s}
          </button>
        ))}
      </div>
      <p style={{ fontSize: 11, color: colors.muted, textAlign: 'center', maxWidth: renderSize }}>
        Scanner missing frames? Try "Slow." Also turn your screen brightness all the way up --
        a dim screen is the most common reason an air-gapped signer can't lock onto the code.
      </p>
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
