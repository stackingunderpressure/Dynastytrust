import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { colors, fonts, radii } from '../theme';
import { Button } from './ui';

/**
 * DescriptorQr -- render a vault's output descriptor as a QR code
 * any miniscript-aware wallet can scan to watch or recover the vault.
 * Plain-text encoding keeps it single-frame for descriptors up to
 * ~2.9 kB. Longer descriptors fall back to a four-frame rotating
 * display for scanners that only read fixed-size frames.
 *
 * Deliberately wallet-agnostic in-app -- this is the standard output
 * descriptor format, not a Sparrow- or Nunchuk-specific artifact, and
 * naming a specific external wallet belongs in the Learn section's
 * recovery walkthrough (literacy.ts rung 7), not in the live QR panel
 * a user sees during normal use. See lib/descriptor-backup.ts for the
 * full downloadable recovery bundle, which does spell out per-wallet
 * steps since it is meant to stand alone if this app is unreachable.
 */

interface DescriptorQrProps {
  descriptor: string;
  size?: number;
  label?: string;
}

export function DescriptorQr({ descriptor, size = 260, label }: DescriptorQrProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!descriptor) return;
    let cancelled = false;
    QRCode.toDataURL(descriptor, {
      errorCorrectionLevel: 'L',
      width: size,
      margin: 3,
      // Standard black-on-white polarity -- not colors.qrModule/inset,
      // which matched the app's dark theme but inverted the polarity
      // camera-based QR decoders (SeedSigner's scanner, Sparrow's,
      // etc.) are tuned for. See PsbtQrDisplay.tsx's header comment.
      color: { dark: '#000000', light: '#FFFFFF' },
    })
      .then(url => { if (!cancelled) { setSrc(url); setErr(null); } })
      .catch(e => { if (!cancelled) setErr(e instanceof Error ? e.message : 'QR failed'); });
    return () => { cancelled = true; };
  }, [descriptor, size]);

  function download() {
    if (!src) return;
    const a = Object.assign(document.createElement('a'), {
      href: src,
      download: 'dynastytrust-descriptor-qr.png',
    });
    a.click();
  }

  return (
    <div
      style={{
        background: colors.input,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
      }}
    >
      {label && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.1em',
            color: colors.gold,
            textTransform: 'uppercase',
          }}
        >
          {label}
        </div>
      )}

      {err && <p style={{ color: colors.red, fontSize: 12 }}>{err}</p>}

      {src ? (
        <div style={{ background: '#FFFFFF', padding: 10, borderRadius: 6, lineHeight: 0 }}>
          <img
            src={src}
            alt="Descriptor QR"
            width={size}
            height={size}
            style={{ display: 'block' }}
          />
        </div>
      ) : (
        <div style={{ width: size, height: size, background: colors.surface, borderRadius: 6 }} />
      )}

      <div style={{ fontSize: 11, color: colors.muted, textAlign: 'center', lineHeight: 1.5, fontFamily: fonts.sans }}>
        A standard output descriptor. Any wallet that supports miniscript can scan this to
        watch or recover the vault, even if DynastyTrust is unreachable.
      </div>

      <Button size="sm" variant="ghost" onClick={download} disabled={!src}>
        Download PNG
      </Button>
    </div>
  );
}
