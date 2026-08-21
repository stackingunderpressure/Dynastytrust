/**
 * recover.ts -- source for the standalone Legacy Recovery tool.
 *
 * Bundled (see tools/legacy-recovery/build.mjs) into ONE self-contained
 * HTML file with no external requests at runtime -- open it in any
 * browser, offline, years from now, with nothing else installed. It
 * imports the SAME crypto functions the live app uses
 * (apps/web/src/lib/legacy-recovery.ts, proven correct by
 * scripts/test-legacy-recovery.mjs) rather than a second hand-typed copy,
 * so there is only one implementation of this math to ever get right.
 * esbuild inlines everything into the output file at build time -- this
 * source file's location in the repo has no bearing on the output
 * artifact's independence from the repo.
 *
 * Three recovery paths, matching legacy-recovery.ts's header exactly:
 *   FAST PATH   -- one keyholder's locked fast-path share + the on-chain
 *                  pad. Pure XOR, the expected common case.
 *   FALLBACK PATH -- two different keyholders' locked fallback shares.
 *                  Real (2,N) Shamir reconstruction, for when the
 *                  on-chain pad is unavailable.
 *   SIGN TO RECOVER (v2) -- the newer, database-free mechanism (see
 *                  legacy-onchain-recovery.ts's header). No vault ID, no
 *                  shares to combine: one key's own signature over a
 *                  fixed message, plus the scriptPubKey of the OP_RETURN
 *                  output it published to (found on any block explorer),
 *                  is the whole recovery.
 * The first two paths recover a 32-byte secret that then decrypts the
 * sealed bundle via unsealBundle; the third derives that same kind of key
 * directly from the signature via recoverViaOnChainPath. Either way the
 * output is the descriptor + policy text.
 *
 * Nothing here ever sends data anywhere. Every input field is local to
 * this page; there is no fetch(), no XHR, no analytics, on purpose --
 * finding the on-chain transaction itself (for the third path) is a
 * manual step the user does in their own browser, on whatever block
 * explorer is reachable at the time, before ever opening this tool.
 */

import {
  deriveLegacyLockBytes,
  deriveLegacyLockBytesFromSignature,
  legacyUnlockMessage,
  legacyOnChainUnlockMessage,
  parseUnlockSignature,
  recoverViaFastPath,
  recoverViaFallbackPath,
  recoverViaOnChainPath,
  unsealBundle,
  unb64,
  type SealedBundle,
} from '../../apps/web/src/lib/legacy-recovery';
import { extractOnChainCandidates } from '../../apps/web/src/lib/legacy-onchain-recovery';
import type { Network } from '../../apps/web/src/lib/keystore';

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

function readNetwork(id: string): Network {
  return ($(id) as HTMLSelectElement).value as Network;
}

async function runFastPath(): Promise<void> {
  try {
    const mnemonic = ($('fp-mnemonic') as HTMLTextAreaElement).value.trim();
    const network = readNetwork('fp-network');
    const vaultId = ($('fp-vault-id') as HTMLInputElement).value.trim();
    const keyRole = ($('fp-key-role') as HTMLInputElement).value.trim();
    const lockedFastShare = unb64(($('fp-locked-share') as HTMLTextAreaElement).value.trim());
    const onChainShare = unb64(($('fp-onchain-share') as HTMLTextAreaElement).value.trim());
    const nonceB64 = ($('fp-nonce') as HTMLInputElement).value.trim();
    const ciphertextB64 = ($('fp-ciphertext') as HTMLTextAreaElement).value.trim();

    if (!mnemonic || !vaultId || !keyRole || !nonceB64 || !ciphertextB64) {
      showResult('Fill in every field above before recovering.', true);
      return;
    }

    const lockBytes = deriveLegacyLockBytes(mnemonic, network, vaultId, keyRole);
    const secret = recoverViaFastPath(lockedFastShare, lockBytes, onChainShare);
    const sealed: SealedBundle = { version: 1, nonceB64, ciphertextB64 };
    const bundle = await unsealBundle(sealed, secret);
    showResult(bundle, false);
  } catch (e) {
    showResult(`Recovery failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

async function runFastPathSignature(): Promise<void> {
  try {
    const vaultId = ($('fs-vault-id') as HTMLInputElement).value.trim();
    const keyRole = ($('fs-key-role') as HTMLInputElement).value.trim();
    const signatureRaw = ($('fs-signature') as HTMLTextAreaElement).value.trim();
    const lockedFastShare = unb64(($('fs-locked-share') as HTMLTextAreaElement).value.trim());
    const onChainShare = unb64(($('fs-onchain-share') as HTMLTextAreaElement).value.trim());
    const nonceB64 = ($('fs-nonce') as HTMLInputElement).value.trim();
    const ciphertextB64 = ($('fs-ciphertext') as HTMLTextAreaElement).value.trim();

    if (!vaultId || !keyRole || !signatureRaw || !nonceB64 || !ciphertextB64) {
      showResult('Fill in every field above before recovering.', true);
      return;
    }

    const signature = parseUnlockSignature(signatureRaw);
    const lockBytes = deriveLegacyLockBytesFromSignature(signature, vaultId, keyRole);
    const secret = recoverViaFastPath(lockedFastShare, lockBytes, onChainShare);
    const sealed: SealedBundle = { version: 1, nonceB64, ciphertextB64 };
    const bundle = await unsealBundle(sealed, secret);
    showResult(bundle, false);
  } catch (e) {
    showResult(`Recovery failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

function updateFastPathSignatureMessage(): void {
  const vaultId = ($('fs-vault-id') as HTMLInputElement).value.trim();
  const keyRole = ($('fs-key-role') as HTMLInputElement).value.trim();
  ($('fs-message') as HTMLTextAreaElement).value =
    vaultId && keyRole ? legacyUnlockMessage(vaultId, keyRole) : '(fill in the vault ID and role above)';
}

async function runFallbackPath(): Promise<void> {
  try {
    const mnemonicA = ($('fb-mnemonic-a') as HTMLTextAreaElement).value.trim();
    const networkA = readNetwork('fb-network-a');
    const vaultIdA = ($('fb-vault-id-a') as HTMLInputElement).value.trim();
    const keyRoleA = ($('fb-key-role-a') as HTMLInputElement).value.trim();
    const lockedShareA = unb64(($('fb-locked-share-a') as HTMLTextAreaElement).value.trim());

    const mnemonicB = ($('fb-mnemonic-b') as HTMLTextAreaElement).value.trim();
    const networkB = readNetwork('fb-network-b');
    const vaultIdB = ($('fb-vault-id-b') as HTMLInputElement).value.trim();
    const keyRoleB = ($('fb-key-role-b') as HTMLInputElement).value.trim();
    const lockedShareB = unb64(($('fb-locked-share-b') as HTMLTextAreaElement).value.trim());

    const nonceB64 = ($('fb-nonce') as HTMLInputElement).value.trim();
    const ciphertextB64 = ($('fb-ciphertext') as HTMLTextAreaElement).value.trim();

    if (!mnemonicA || !vaultIdA || !keyRoleA || !mnemonicB || !vaultIdB || !keyRoleB || !nonceB64 || !ciphertextB64) {
      showResult('Fill in every field above before recovering.', true);
      return;
    }

    const lockBytesA = deriveLegacyLockBytes(mnemonicA, networkA, vaultIdA, keyRoleA);
    const lockBytesB = deriveLegacyLockBytes(mnemonicB, networkB, vaultIdB, keyRoleB);
    const secret = await recoverViaFallbackPath(lockedShareA, lockBytesA, lockedShareB, lockBytesB);
    const sealed: SealedBundle = { version: 1, nonceB64, ciphertextB64 };
    const bundle = await unsealBundle(sealed, secret);
    showResult(bundle, false);
  } catch (e) {
    showResult(`Recovery failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

async function runOnChainPath(): Promise<void> {
  try {
    const vaultIndexRaw = ($('oc-vault-index') as HTMLInputElement).value.trim();
    const scriptPubkeyHex = ($('oc-scriptpubkey') as HTMLTextAreaElement).value.trim();
    const signatureRaw = ($('oc-signature') as HTMLTextAreaElement).value.trim();

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
      showResult("That doesn't decode as a Legacy Recovery v2 payload -- double check you copied the OP_RETURN output's full scriptPubKey (hex), not just the address or the txid.", true);
      return;
    }

    const signature = parseUnlockSignature(signatureRaw);
    const bundle = await recoverViaOnChainPath(signature, vaultIndex, candidates[0].sealed);
    showResult(bundle, false);
  } catch (e) {
    showResult(`Recovery failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

function updateOnChainMessage(): void {
  const vaultIndexRaw = ($('oc-vault-index') as HTMLInputElement).value.trim();
  const vaultIndex = parseInt(vaultIndexRaw, 10);
  ($('oc-message') as HTMLTextAreaElement).value =
    Number.isInteger(vaultIndex) && vaultIndex >= 0
      ? legacyOnChainUnlockMessage(vaultIndex)
      : '(fill in the vault index above)';
}

function switchTab(which: 'fast' | 'fast-sig' | 'fallback' | 'onchain'): void {
  $('panel-fast').style.display = which === 'fast' ? 'block' : 'none';
  $('panel-fast-sig').style.display = which === 'fast-sig' ? 'block' : 'none';
  $('panel-fallback').style.display = which === 'fallback' ? 'block' : 'none';
  $('panel-onchain').style.display = which === 'onchain' ? 'block' : 'none';
  $('tab-fast').setAttribute('aria-selected', String(which === 'fast'));
  $('tab-fast-sig').setAttribute('aria-selected', String(which === 'fast-sig'));
  $('tab-fallback').setAttribute('aria-selected', String(which === 'fallback'));
  $('tab-onchain').setAttribute('aria-selected', String(which === 'onchain'));
}

window.addEventListener('DOMContentLoaded', () => {
  $('tab-fast').addEventListener('click', () => switchTab('fast'));
  $('tab-fast-sig').addEventListener('click', () => switchTab('fast-sig'));
  $('tab-fallback').addEventListener('click', () => switchTab('fallback'));
  $('tab-onchain').addEventListener('click', () => switchTab('onchain'));
  $('fp-run').addEventListener('click', () => { void runFastPath(); });
  $('fs-run').addEventListener('click', () => { void runFastPathSignature(); });
  $('fb-run').addEventListener('click', () => { void runFallbackPath(); });
  $('oc-run').addEventListener('click', () => { void runOnChainPath(); });
  $('fs-vault-id').addEventListener('input', updateFastPathSignatureMessage);
  $('fs-key-role').addEventListener('input', updateFastPathSignatureMessage);
  $('oc-vault-index').addEventListener('input', updateOnChainMessage);
  updateFastPathSignatureMessage();
  updateOnChainMessage();
});
