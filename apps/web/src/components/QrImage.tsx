import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { colors } from '../theme';

interface QrImageProps {
  data: string;
  size?: number;
}

// // -- QR display
// Renders `data` as a PNG data URL sized for comfortable mobile
// scanning. Standard black-on-white polarity, wrapped in a white card
// -- NOT the theme's dark surface + light foreground. Operator,
// 2026-08-11 ("The seed signer will not scan the transaction qr ...
// needs more display settings speed bright"): that dark-theme-matching
// choice quietly inverted the polarity every camera-based QR decoder
// (SeedSigner's included) is tuned for. See PsbtQrDisplay.tsx's header
// comment for the fuller account -- same bug, same fix, applied here.

export function QrImage({ data, size = 240 }: QrImageProps) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(data, {
      width: size,
      margin: 3,
      errorCorrectionLevel: 'L',
      color: { dark: '#000000', light: '#FFFFFF' },
    })
      .then(url => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        /* silently -- the raw value is still displayed below */
      });
    return () => {
      cancelled = true;
    };
  }, [data, size]);

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
    <div style={{ background: '#FFFFFF', padding: 12, borderRadius: 8, lineHeight: 0, display: 'inline-block' }}>
      <img
        src={src}
        alt="QR"
        width={size}
        height={size}
        style={{ display: 'block' }}
      />
    </div>
  );
}
