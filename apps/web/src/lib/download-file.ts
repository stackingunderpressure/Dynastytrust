/**
 * download-file.ts -- the ONE way this app triggers a browser "save
 * this file" action, used by every backup/export download (vault
 * backup, Tranche wallet backup, Legacy Recovery note, keyring export,
 * descriptor QR PNG).
 *
 * The plain `<a download>` + blob-URL trick every one of these sites
 * used to hand-roll independently is unreliable on mobile Safari in
 * particular: iOS has a long history of that pattern silently doing
 * nothing, or opening the raw file content in a new tab instead of
 * saving it, especially when the anchor is never attached to the DOM
 * before `.click()` and the object URL gets revoked synchronously
 * right after -- both of which every prior call site did. Two fixes,
 * applied once here instead of five times:
 *   1. Where the Web Share API supports file shares (most modern
 *      phones, iOS included), prefer it -- it hands the file to the
 *      OS's native share sheet, which has a real "Save to Files"
 *      option and is far more reliable than a blob download on iOS.
 *   2. Otherwise, fall back to the anchor-click download, but attach
 *      the anchor to the DOM before clicking and delay revoking the
 *      object URL, rather than revoking it the instant `.click()`
 *      returns -- on some engines the download hasn't actually started
 *      reading the blob yet at that point.
 */

/**
 * Returns false only when the user explicitly cancelled a share sheet,
 * so a caller gating on "did this actually save" (the vault wizard's
 * backup step, which won't let you continue until the backup file is
 * down) doesn't mark it downloaded when it wasn't. The anchor-click
 * fallback has no way to detect success or failure and always
 * resolves true, matching how this always behaved before.
 */
export async function downloadFile(
  filename: string,
  content: Blob | string,
  mimeType = 'text/plain',
): Promise<boolean> {
  const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;

  if (typeof File !== 'undefined' && navigator.canShare) {
    const file = new File([blob], filename, { type: blob.type || mimeType });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return true;
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return false;
        // Any other share failure -- fall through to the download path below.
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Convenience wrapper for the common case: a plain text file. */
export function downloadTextFile(filename: string, text: string, mimeType = 'text/plain'): Promise<boolean> {
  return downloadFile(filename, text, mimeType);
}
