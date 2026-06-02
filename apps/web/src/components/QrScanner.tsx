import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { colors, fonts, radii } from '../theme';
import { Button } from './ui';

interface QrScannerProps {
  /**
   * Called with the decoded string from the first QR code detected.
   * The component immediately stops the camera after firing this.
   */
  onResult: (text: string) => void;
  onCancel?: () => void;
}

// // -- QR scanner
// Grabs the back camera if available, paints frames to a hidden
// canvas, runs jsQR on each frame. First match wins. Cleans up the
// MediaStream on unmount so the browser doesn't leave the indicator
// light on.

export function QrScanner({ onResult, onCancel }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
              onResult(code.data);
              return;
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
      {onCancel && (
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}
