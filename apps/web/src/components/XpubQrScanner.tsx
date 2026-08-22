import { useRef, useState } from 'react';
import { URDecoder } from '@gandlaf21/bc-ur';
import { parseXpubText } from '../lib/keystore';
import { colors, fonts, radii } from '../theme';
import { Button } from './ui';
import { useQrCameraLoop } from './useQrCameraLoop';
import { QrScanStatus } from './QrScanStatus';

/**
 * Camera QR scanner for importing an xpub from a hardware signer
 * (SeedSigner, Coldcard, etc.) -- the inverse of typing a 100+
 * character extended pubkey and a derivation path on a phone keyboard.
 * Same camera-loop mechanics as PsbtQrScanner (getUserMedia + jsQR +
 * requestAnimationFrame), adapted for what a signer's xpub/wallet
 * export QR actually contains rather than a PSBT.
 *
 * Handles, per frame, via keystore.ts's parseXpubText (shared with the
 * file-import path so both routes read the same set of formats the
 * same way):
 *   1. A BIP-380 key-origin string -- [fingerprint/path]xpub..., what
 *      SeedSigner/Sparrow/Coldcard's descriptor-style exports actually
 *      show. Carries the REAL derivation path the signer used, which
 *      matters: without it, the caller would fall back to a guessed
 *      default path, and a signer asked to sign with the wrong path
 *      can't re-derive the matching private key at all (see keystore.ts
 *      splitKeyOrigin's own doc comment, and this repo's known-issues
 *      history of exactly this failure).
 *   2. A bare xpub/tpub/etc. string with no origin info -- some signers
 *      show just the key itself. Fires with path === null so the
 *      caller knows to leave its derivation-path field exactly as it
 *      was, instead of silently guessing.
 *   3. JSON text (single QR or reassembled from a UR sequence) --
 *      same parser the file-import path already uses, so a signer that
 *      puts its file-export JSON into a QR instead of (or in addition
 *      to) a file works too.
 *   4. Anything else UR-encoded that ISN'T JSON once decoded (a real
 *      BCR crypto-hdkey/crypto-account CBOR payload -- this is what
 *      SeedSigner's "UR2 / BC-UR" xpub export FORMAT sends; the
 *      operator hit this directly) is deliberately NOT hand-parsed --
 *      getting key-derivation metadata wrong is a worse failure than
 *      not supporting a format yet, so this surfaces an honest error
 *      instead of guessing at an unfamiliar binary encoding of key
 *      material. Workaround until real BCR registry decoding is built:
 *      on the signer, export the xpub as "Static" (single QR, plain
 *      `[fingerprint/path]xpub...` text per BIP-380) instead of the
 *      animated UR format -- format #1 above already handles that
 *      correctly. 2026-08-11 fix: decoding a structured type used to
 *      throw partway through and get swallowed by the catch-all below
 *      (meant only for "malformed fragment, keep scanning"), so the
 *      screen hung forever at "100% received" with no error and no
 *      hint toward the Static workaround -- see the isolated try/catch
 *      around the decode below.
 */

interface XpubQrScannerProps {
  /** path is null when the scan only found a bare xpub -- the caller
   *  should leave its own derivation-path field untouched rather than
   *  overwrite it with information this scan doesn't have. fingerprint
   *  is null under the same condition, and matters even more: it is the
   *  ONLY trustworthy source of the master fingerprint a hardware wallet
   *  needs (see keystore.ts's importXpub doc comment -- there is no way
   *  to derive it from a bare xpub after the fact). */
  onResult: (xpub: string, path: string | null, fingerprint: string | null) => void;
  onCancel?: () => void;
}

export function XpubQrScanner({ onResult, onCancel }: XpubQrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const decoderRef = useRef<URDecoder>(new URDecoder());
  const seenRef = useRef<Set<string>>(new Set());
  const [scanError, setScanError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [received, setReceived] = useState(0);
  const [expected, setExpected] = useState(0);

  function tryText(text: string): boolean {
    const parsed = parseXpubText(text);
    if (!parsed) return false;
    onResult(parsed.xpub, parsed.path, parsed.fingerprint);
    return true;
  }

  function handleScan(text: string): boolean {
    if (!text) return false;
    const trimmed = text.trim();

    if (tryText(trimmed)) return true;

    if (!trimmed.toLowerCase().startsWith('ur:')) return false;
    if (seenRef.current.has(trimmed)) return false;
    seenRef.current.add(trimmed);
    const dec = decoderRef.current;
    try {
      dec.receivePart(trimmed);
      const est = (dec.expectedPartCount?.() ?? 0) || 0;
      const got = dec.receivedPartIndexes?.()?.length ?? 0;
      setExpected(est);
      setReceived(got);
      setProgress(dec.estimatedPercentComplete?.() ?? 0);
      if (dec.isComplete()) {
        if (dec.isSuccess()) {
          const ur = dec.resultUR();
          // A structured BCR type (crypto-account, crypto-hdkey -- what
          // SeedSigner's animated "UR2 / BC-UR" xpub export format sends)
          // decodes to a nested CBOR array/map, not flat bytes -- this
          // app doesn't parse that registry yet (see file header comment,
          // point 4). Converting it as if it were bytes throws, and that
          // throw used to escape to the outer catch below, which is only
          // meant for "malformed fragment, keep scanning" -- so the whole
          // screen went silent forever at "100% received" with the real
          // fix (switch SeedSigner to Static QR format) never surfaced.
          // Isolate the decode so a structured-type failure always
          // reaches the intended error message instead of hanging.
          try {
            const decoded = ur.decodeCBOR();
            const buf: Uint8Array = decoded instanceof Uint8Array ? decoded : new Uint8Array(decoded);
            const asText = new TextDecoder().decode(buf);
            if (tryText(asText)) return true;
          } catch {
            /* fall through to the "doesn't parse yet" message below */
          }
          setScanError(
            `Scanned a "${ur.type}" QR this app doesn't parse yet -- on the signer, switch the xpub export format to "Static" (a single QR, not animated) and scan again.`,
          );
        } else {
          setScanError('QR scan failed -- try again.');
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
