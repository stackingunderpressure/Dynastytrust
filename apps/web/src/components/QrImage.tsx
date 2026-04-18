import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { colors } from '../theme';

interface QrImageProps {
  data: string;
  size?: number;
}

// // -- QR display
// Renders `data` as a PNG data URL sized for comfortable mobile
// scanning. Uses the theme's dark surface + light foreground so the
// image works on our dark theme without inverting.

export function QrImage({ data, size = 240 }: QrImageProps) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(data, {
      width: size,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#E8E4D8', light: '#07070F' },
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
    <img
      src={src}
      alt="QR"
      width={size}
      height={size}
      style={{ borderRadius: 8, display: 'block' }}
    />
  );
}
