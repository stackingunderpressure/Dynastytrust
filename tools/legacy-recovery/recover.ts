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
 * The mechanism: no vault ID, no shares to combine, no database --
 * one key's own on-chain address IS the lookup. Find the OP_RETURN
 * transaction on any block explorer beforehand (using the address from
 * your recovery note), paste its scriptPubKey hex here along with the
 * vault index, then sign the exact message shown with the SAME key to
 * unlock the full descriptor.
 *
 * Nothing here ever sends data anywhere. Every input field is local to
 * this page; there is no fetch(), no XHR, no analytics, on purpose --
 * finding the on-chain transaction itself is a manual step the user does
 * in their own browser, on whatever block explorer is reachable at the
 * time, before ever opening this tool.
 */

import {
  legacyOnChainUnlockMessage,
  parseUnlockSignature,
  recoverViaOnChainPath,
} from '../../apps/web/src/lib/legacy-recovery';
import { extractOnChainCandidates } from '../../apps/web/src/lib/legacy-onchain-recovery';

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
    const vaultIndexRaw = ($('vault-index') as HTMLInputElement).value.trim();
    const scriptPubkeyHex = ($('scriptpubkey') as HTMLTextAreaElement).value.trim();
    const signatureRaw = ($('signature') as HTMLTextAreaElement).value.trim();

    const vaultIndex = parseInt(vaultIndexRaw, 10);
    if (!Number.isInteger(vaultIndex) || vaultIndex < 0) {
      showResult('Vault index must be a whole number, 0 or greater.', true);
      return;
    }
    if (!scriptPubkeyHex || !signatureRaw) {
      showResult('Fill in every field above before recovering.', true);
      return;
    }

    const candidates = extractOnChainCandidates([
      { txid: '0'.repeat(64), vout: [{ scriptpubkey_type: 'op_return', scriptpubkey: scriptPubkeyHex }] },
    ]);
    if (candidates.length === 0) {
      showResult("That doesn't decode as a Legacy Recovery payload -- double check you copied the OP_RETURN output's full scriptPubKey (hex), not just the address or the txid.", true);
      return;
    }

    const signature = parseUnlockSignature(signatureRaw);
    const bundle = await recoverViaOnChainPath(signature, vaultIndex, candidates[0].sealed);
    showResult(bundle, false);
  } catch (e) {
    showResult(`Recovery failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

function updateMessage(): void {
  const vaultIndexRaw = ($('vault-index') as HTMLInputElement).value.trim();
  const vaultIndex = parseInt(vaultIndexRaw, 10);
  ($('message') as HTMLTextAreaElement).value =
    Number.isInteger(vaultIndex) && vaultIndex >= 0
      ? legacyOnChainUnlockMessage(vaultIndex)
      : '(fill in the vault index above)';
}

window.addEventListener('DOMContentLoaded', () => {
  $('run').addEventListener('click', () => { void runRecovery(); });
  $('vault-index').addEventListener('input', updateMessage);
  updateMessage();
});
