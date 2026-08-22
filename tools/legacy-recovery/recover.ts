/**
 * recover.ts -- source for the standalone Legacy Recovery tool.
 *
 * Bundled (see tools/legacy-recovery/build.mjs) into ONE self-contained
 * HTML file with no external requests at runtime -- open it in any
 * browser, offline, years from now, with nothing else installed. It
 * imports the SAME crypto functions the live app uses
 * (apps/web/src/lib/legacy-recovery.ts) rather than a second hand-typed
 * copy, so there is only one implementation of this math to ever get
 * right.
 *
 * The mechanism: no vault ID, no shares to combine, no database -- one
 * key's own on-chain address IS the lookup, and it's the SAME single
 * address for every vault that key ever publishes Legacy Recovery for --
 * no index to remember. Find the OP_RETURN transaction on any block
 * explorer beforehand (using the address from your recovery note), paste
 * its scriptPubKey hex here -- the tool decodes it and shows the exact
 * message to sign, built from the nonce already published right there,
 * nothing memorized or typed from a note -- then sign it with the SAME
 * key to unlock the full descriptor.
 *
 * The message can also be shown as a QR code and scanned straight into
 * an airgapped signer's "Sign Message" feature (SeedSigner, Krux, and
 * most others support this) instead of typed in by hand -- and the
 * resulting signature can be scanned back in the same way, off the
 * signer's own output QR, rather than copied across an airgap by
 * transcription. Both use the camera as a local device capability, not
 * a network request.
 *
 * Nothing here ever sends data anywhere. Every input field is local to
 * this page; there is no fetch(), no XHR, no analytics, on purpose --
 * finding the on-chain transaction itself is a manual step the user does
 * in their own browser, on whatever block explorer is reachable at the
 * time, before ever opening this tool.
 */

import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  legacyOnChainNonceMessage,
  parseUnlockSignature,
  recoverViaOnChainPath,
  decodeOnChainPayload,
  unb64,
} from '../../apps/web/src/lib/legacy-recovery';
import { extractOnChainCandidates, type OnChainCandidate } from '../../apps/web/src/lib/legacy-onchain-recovery';
import { hexToBytes } from '../../apps/web/src/lib/onchain-publish';

/**
 * Accepts either of two hex strings people paste here, since they look
 * identical at a glance but aren't: a block explorer's "scriptPubKey"
 * for the OP_RETURN output (the OP_RETURN opcode + a push-length byte
 * wrapped around the payload) -- the normal case -- or the bare payload
 * hex DynastyTrust's "Seal payload" step shows to copy into another
 * wallet, if someone pastes that directly here instead by mistake. Tries
 * the scriptPubKey unwrap first; if that doesn't decode as a Legacy
 * Recovery payload, falls back to treating the input as the raw payload
 * bytes themselves before giving up.
 */
function decodeScriptPubkey(input: string): OnChainCandidate | null {
  const scriptCandidates = extractOnChainCandidates([
    { txid: '0'.repeat(64), vout: [{ scriptpubkey_type: 'op_return', scriptpubkey: input }] },
  ]);
  if (scriptCandidates.length > 0) return scriptCandidates[0];
  try {
    const sealed = decodeOnChainPayload(hexToBytes(input));
    return sealed ? { txid: '0'.repeat(64), sealed } : null;
  } catch {
    return null;
  }
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

function showResult(text: string, isError: boolean): void {
  const out = $('result') as HTMLTextAreaElement;
  out.value = text;
  out.style.borderColor = isError ? '#c0392b' : '#2f9e44';
}

async function runRecovery(): Promise<void> {
  try {
    const scriptPubkeyHex = ($('scriptpubkey') as HTMLTextAreaElement).value.trim();
    const signatureRaw = ($('signature') as HTMLTextAreaElement).value.trim();

    if (!scriptPubkeyHex || !signatureRaw) {
      showResult('Fill in every field above before recovering.', true);
      return;
    }

    const candidate = decodeScriptPubkey(scriptPubkeyHex);
    if (!candidate) {
      showResult("That doesn't decode as a Legacy Recovery payload -- double check you copied the OP_RETURN output's full scriptPubKey (hex) from a block explorer (or the raw payload hex from DynastyTrust's Seal step), not just the address or the txid.", true);
      return;
    }

    const signature = parseUnlockSignature(signatureRaw);
    const bundle = await recoverViaOnChainPath(signature, candidate.sealed);
    showResult(bundle, false);
  } catch (e) {
    showResult(`Recovery failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

function updateMessage(): void {
  const scriptPubkeyHex = ($('scriptpubkey') as HTMLTextAreaElement).value.trim();
  const candidate = scriptPubkeyHex ? decodeScriptPubkey(scriptPubkeyHex) : null;
  ($('message') as HTMLTextAreaElement).value = candidate
    ? legacyOnChainNonceMessage(unb64(candidate.sealed.nonceB64))
    : '(paste the on-chain scriptPubKey hex above)';
  // Any change to the message invalidates a previously shown QR --
  // hide it rather than leave a stale code on screen.
  ($('message-qr-wrap') as HTMLElement).style.display = 'none';
  ($('message-qr-img') as HTMLImageElement).src = '';
}

// ── Message QR display -- lets the message be scanned directly into an
// airgapped signer's "Sign Message" feature instead of typed in by hand,
// character by character, on a 5-way joystick. Pure client-side image
// generation, no network call. ──────────────────────────────────────────
async function toggleMessageQr(): Promise<void> {
  const wrap = $('message-qr-wrap') as HTMLElement;
  const showing = wrap.style.display !== 'none';
  if (showing) {
    wrap.style.display = 'none';
    return;
  }
  const message = ($('message') as HTMLTextAreaElement).value;
  if (!message || message.startsWith('(fill in')) return;
  const url = await QRCode.toDataURL(message, {
    width: 220, margin: 3, errorCorrectionLevel: 'L',
    color: { dark: '#000000', light: '#FFFFFF' },
  });
  ($('message-qr-img') as HTMLImageElement).src = url;
  wrap.style.display = 'block';
}

// ── Signature QR scan -- reads the signature straight off the signer's
// own output QR instead of it being hand-typed or copy-pasted across an
// airgap. Grabs the back camera, paints frames to a hidden canvas, runs
// jsQR on each frame; stops itself on the first match. Same technique
// QrScanner.tsx uses in the live app, reimplemented here in plain DOM
// since this tool has no React runtime -- still zero network calls, a
// camera permission is a device capability, not a request to anywhere.
let signatureScanStream: MediaStream | null = null;
let signatureScanRaf: number | null = null;

function stopSignatureScan(): void {
  if (signatureScanRaf != null) cancelAnimationFrame(signatureScanRaf);
  signatureScanRaf = null;
  signatureScanStream?.getTracks().forEach(t => t.stop());
  signatureScanStream = null;
  ($('signature-scan-wrap') as HTMLElement).style.display = 'none';
  ($('signature-scan-cancel') as HTMLElement).style.display = 'none';
}

async function startSignatureScan(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    showResult('Camera access is not supported in this browser.', true);
    return;
  }
  const wrap = $('signature-scan-wrap') as HTMLElement;
  const video = $('signature-scan-video') as HTMLVideoElement;
  const canvas = $('signature-scan-canvas') as HTMLCanvasElement;
  wrap.style.display = 'block';
  ($('signature-scan-cancel') as HTMLElement).style.display = 'inline-block';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    signatureScanStream = stream;
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    showResult(`Could not access the camera: ${e instanceof Error ? e.message : String(e)}`, true);
    stopSignatureScan();
    return;
  }
  const tick = () => {
    if (!signatureScanStream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const w = video.videoWidth, h = video.videoHeight;
      if (w && h) {
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h);
          const img = ctx.getImageData(0, 0, w, h);
          const code = jsQR(img.data, img.width, img.height);
          if (code?.data) {
            ($('signature') as HTMLTextAreaElement).value = code.data;
            stopSignatureScan();
            return;
          }
        }
      }
    }
    signatureScanRaf = requestAnimationFrame(tick);
  };
  tick();
}

window.addEventListener('DOMContentLoaded', () => {
  $('run').addEventListener('click', () => { void runRecovery(); });
  $('scriptpubkey').addEventListener('input', updateMessage);
  $('message-qr-toggle').addEventListener('click', () => { void toggleMessageQr(); });
  $('signature-scan-start').addEventListener('click', () => { void startSignatureScan(); });
  $('signature-scan-cancel').addEventListener('click', stopSignatureScan);
  updateMessage();
});
