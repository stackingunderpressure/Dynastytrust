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
 * Two recovery paths, matching legacy-recovery.ts's header exactly:
 *   FAST PATH   -- one keyholder's locked fast-path share + the on-chain
 *                  pad. Pure XOR, the expected common case.
 *   FALLBACK PATH -- two different keyholders' locked fallback shares.
 *                  Real (2,N) Shamir reconstruction, for when the
 *                  on-chain pad is unavailable.
 * Either path recovers the same 32-byte secret, which then decrypts the
 * sealed bundle (the descriptor + policy text) via unsealBundle.
 *
 * Nothing here ever sends data anywhere. Every input field is local to
 * this page; there is no fetch(), no XHR, no analytics, on purpose.
 */

import {
  deriveLegacyLockBytes,
  deriveLegacyLockBytesFromSignature,
  legacyUnlockMessage,
  parseUnlockSignature,
  recoverViaFastPath,
  recoverViaFallbackPath,
  unsealBundle,
  unb64,
  type SealedBundle,
} from '../../apps/web/src/lib/legacy-recovery';
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

function switchTab(which: 'fast' | 'fast-sig' | 'fallback'): void {
  $('panel-fast').style.display = which === 'fast' ? 'block' : 'none';
  $('panel-fast-sig').style.display = which === 'fast-sig' ? 'block' : 'none';
  $('panel-fallback').style.display = which === 'fallback' ? 'block' : 'none';
  $('tab-fast').setAttribute('aria-selected', String(which === 'fast'));
  $('tab-fast-sig').setAttribute('aria-selected', String(which === 'fast-sig'));
  $('tab-fallback').setAttribute('aria-selected', String(which === 'fallback'));
}

window.addEventListener('DOMContentLoaded', () => {
  $('tab-fast').addEventListener('click', () => switchTab('fast'));
  $('tab-fast-sig').addEventListener('click', () => switchTab('fast-sig'));
  $('tab-fallback').addEventListener('click', () => switchTab('fallback'));
  $('fp-run').addEventListener('click', () => { void runFastPath(); });
  $('fs-run').addEventListener('click', () => { void runFastPathSignature(); });
  $('fb-run').addEventListener('click', () => { void runFallbackPath(); });
  $('fs-vault-id').addEventListener('input', updateFastPathSignatureMessage);
  $('fs-key-role').addEventListener('input', updateFastPathSignatureMessage);
  updateFastPathSignatureMessage();
});
