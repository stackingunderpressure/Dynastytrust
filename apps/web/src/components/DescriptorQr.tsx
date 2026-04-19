import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { colors, fonts, radii } from '../theme';
import { Button } from './ui';

/**
 * DescriptorQr -- render a vault's output descriptor as a QR code
 * that Sparrow (and most miniscript-aware wallets) can scan via
 * File > Import Wallet. Plain-text encoding keeps it single-frame
 * for descriptors up to ~2.9 kB. Longer descriptors fall back to a
 * four-frame rotating display so Sparrow's multi-frame reader can
 * reassemble.
 *
 * Sparrow import path:
 *   File > Import Wallet > Scan QR Code > point at this panel.
 *   Sparrow uses the descriptor to rebuild all three Taproot leaves
 *   and track every address the vault can receive to, even offline.
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
      margin: 2,
      color: { dark: '#F4F0CE', light: '#0A0A14' },
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
        <img
          src={src}
          alt="Descriptor QR"
          width={size}
          height={size}
          style={{ background: '#0A0A14', borderRadius: 6 }}
        />
      ) : (
        <div style={{ width: size, height: size, background: colors.surface, borderRadius: 6 }} />
      )}

      <div style={{ fontSize: 11, color: colors.muted, textAlign: 'center', lineHeight: 1.5, fontFamily: fonts.sans }}>
        Sparrow: File &gt; Import Wallet &gt; Scan QR Code.
        <br />
        Nunchuk: use the BSMS export on the Policy page for now (Nunchuk QR import is BSMS, not raw descriptor).
      </div>

      <Button size="sm" variant="ghost" onClick={download} disabled={!src}>
        Download PNG
      </Button>
    </div>
  );
}
