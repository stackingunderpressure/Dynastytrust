import { useRef } from 'react';
import { colors, fonts, radii } from '../theme';
import { Button } from './ui';
import { useQrCameraLoop } from './useQrCameraLoop';
import { QrScanStatus } from './QrScanStatus';

interface QrScannerProps {
  /**
   * Called with the decoded string from the first QR code detected.
   * The component immediately stops the camera after firing this.
   */
  onResult: (text: string) => void;
  onCancel?: () => void;
}

// // -- QR scanner (single frame, no UR reassembly -- for a short
// value like a signature that always fits in one static QR code; see
// XpubQrScanner/PsbtQrScanner for anything that might arrive as an
// animated multi-fragment sequence). Camera capture and the jsQR loop
// live in useQrCameraLoop, shared by every scanner in this app.

export function QrScanner({ onResult, onCancel }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { error, scanning, elapsedMs } = useQrCameraLoop(videoRef, (text) => {
    onResult(text);
    return true;
  });

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
      {scanning && !error && <QrScanStatus elapsedMs={elapsedMs} />}
      {onCancel && (
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}
