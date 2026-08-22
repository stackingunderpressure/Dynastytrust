import { useEffect, useRef, useState, type RefObject } from 'react';
import jsQR from 'jsqr';

export interface QrCameraLoopState {
  /** Camera/permission error -- null once a stream is live. */
  error: string | null;
  /** True from the moment the camera stream starts until onFrame returns true (a final result) or the component unmounts. */
  scanning: boolean;
  /** Milliseconds since the camera stream started -- drives the "still scanning" liveness feedback. */
  elapsedMs: number;
}

/**
 * Shared camera-capture + jsQR decode loop for every QR scanner in this
 * app (QrScanner, PsbtQrScanner, XpubQrScanner). Before this existed,
 * each of those three components hand-rolled its own near-identical
 * copy of getUserMedia + requestAnimationFrame + jsQR -- meaning a fix
 * to camera quality or scanning feedback had to be applied three times
 * and inevitably drifted. One implementation means it lands everywhere
 * at once, including in any future scanner built on this hook.
 *
 * Two concrete fixes this hook makes for every caller, not just one:
 *   1. Requests a higher-resolution video stream (ideal 1280x1280) with
 *      continuous autofocus where supported, falling back to the plain
 *      unconstrained request if the browser rejects the richer
 *      constraint set outright (some engines throw OverconstrainedError
 *      instead of silently ignoring an unsupported `advanced` entry).
 *      The default unconstrained stream on many phones is low enough
 *      resolution that a dense QR (a descriptor-bearing xpub export, a
 *      UR-encoded PSBT fragment) is genuinely too blurry for jsQR to
 *      ever lock onto -- this is the single biggest lever on "finicky"
 *      scanning, not a jsQR bug.
 *   2. Exposes `scanning` and `elapsedMs` so every caller can show live
 *      "still scanning" feedback instead of a silent video feed with no
 *      indication anything is happening until a code is (or isn't)
 *      found -- the other half of "is it even reading" complaints.
 *
 * onFrame is read via a ref, not a dependency, so passing a fresh
 * inline function every render (the common React pattern) never tears
 * down and restarts the camera mid-scan -- the effect only re-runs if
 * the videoRef object itself changes, which it doesn't for the
 * lifetime of a mounted scanner.
 */
export function useQrCameraLoop(
  videoRef: RefObject<HTMLVideoElement | null>,
  onFrame: (text: string) => boolean | void,
): QrCameraLoopState {
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let elapsedTimer: number | undefined;
    const canvas = document.createElement('canvas');

    async function requestStream(): Promise<MediaStream> {
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 1280 },
            advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
          },
          audio: false,
        });
      } catch {
        // Some browsers reject an unsupported `advanced` constraint
        // outright rather than ignoring it -- fall back to the plain
        // request before giving up.
        return navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      }
    }

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Camera access isn't supported in this browser.");
        return;
      }
      let stream: MediaStream;
      try {
        stream = await requestStream();
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not access the camera. Check permissions.');
        }
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      if (cancelled) return;
      startedAtRef.current = Date.now();
      setScanning(true);
      elapsedTimer = window.setInterval(() => {
        if (!cancelled) setElapsedMs(Date.now() - startedAtRef.current);
      }, 500);
      tick();
    }

    function tick() {
      if (cancelled) return;
      const video = videoRef.current;
      if (video && video.readyState === video.HAVE_ENOUGH_DATA) {
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
              const done = onFrameRef.current(code.data);
              if (done) {
                cancelled = true;
                setScanning(false);
                if (elapsedTimer != null) window.clearInterval(elapsedTimer);
                streamRef.current?.getTracks().forEach(t => t.stop());
                return;
              }
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
      if (elapsedTimer != null) window.clearInterval(elapsedTimer);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [videoRef]);

  return { error, scanning, elapsedMs };
}
