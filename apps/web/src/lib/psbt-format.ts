/**
 * psbt-format.ts -- accept PSBT input in whatever form the user pastes.
 *
 * Hardware wallets vary: Coldcard exports base64 with the magic
 * bytes "cHNidP8=...", Sparrow often exports hex, Nunchuk does
 * both depending on the export surface. Rather than force users
 * to know which is which, detect and normalize to hex (what the
 * server and our signing libs expect).
 */

const HEX_MAGIC = '70736274ff';
// Base64 of the magic bytes. Start of any valid PSBT when b64-encoded.
const B64_MAGIC = 'cHNidP8';

function base64ToHex(b64: string): string {
  const clean = b64.replace(/\s+/g, '');
  const bin = atob(clean);
  let out = '';
  for (let i = 0; i < bin.length; i++) {
    out += bin.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Returns the PSBT as hex, or null if the input doesn't look like
 * a PSBT in any supported format.
 */
export function normalizePsbt(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith(HEX_MAGIC)) {
    // Accept even if the user pasted upper-case; normalize.
    return lower.replace(/\s+/g, '');
  }

  // Base64 is case-sensitive; keep the original casing for atob.
  const firstWord = trimmed.replace(/\s+/g, '').slice(0, 7);
  if (firstWord === B64_MAGIC) {
    try {
      return base64ToHex(trimmed);
    } catch {
      return null;
    }
  }

  return null;
}
