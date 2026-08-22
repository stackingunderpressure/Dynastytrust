import { colors, fonts } from '../theme';

/**
 * Live "still scanning" feedback shown under every camera QR scanner.
 * Before this, a scanner that hadn't yet found a code showed nothing
 * but the raw video feed -- no way to tell whether it was actively
 * trying and just hadn't found the code yet, or silently stuck. The
 * elapsed-seconds count is the liveness signal (it visibly ticks), and
 * past a few seconds a hint nudges toward the two things that actually
 * cause most failed scans: the code not filling the frame, or poor
 * lighting/focus -- not a bug in the decoder.
 */
export function QrScanStatus({ elapsedMs }: { elapsedMs: number }) {
  const seconds = Math.floor(elapsedMs / 1000);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: colors.sub, fontFamily: fonts.sans }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors.gold }} />
        Scanning... {seconds}s
      </div>
      {seconds >= 5 && (
        <div style={{ fontSize: 12, color: colors.muted, fontFamily: fonts.sans, textAlign: 'center', maxWidth: 280 }}>
          Still looking -- make sure the whole QR code fills the frame, hold steady, and check the lighting.
        </div>
      )}
    </div>
  );
}
