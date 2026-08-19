// One-off verification (not part of `npm test`): loads the built
// standalone recovery tool in a real headless browser and drives the
// fast path end to end, confirming the bundled artifact actually
// recovers the exact bundle text -- not just that it builds without
// errors. Run manually: node --experimental-strip-types --import
// ./scripts/register-ts-resolver.mjs scripts/verify-legacy-recovery-tool.mjs
import playwright from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = playwright;
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import {
  generateLegacySecret, sealBundle, splitLegacySecretHybrid,
  deriveLegacyLockBytes, deriveLegacyLockBytesFromSignature, signLegacyUnlockMessage,
  lockShare, b64,
} from '../apps/web/src/lib/legacy-recovery.ts';

const network = 'testnet';
const vaultId = 'verify-vault-001';
const roleA = 'founder_1';
const roleB = 'backup_1';
const roleFast = 'heir_2';
const roleSig = 'heir_3';
const derivationPathSig = "m/86'/1'/0'";
const mnemonicA = generateMnemonic(wordlist);
const mnemonicB = generateMnemonic(wordlist);
const mnemonicFast = generateMnemonic(wordlist);
const mnemonicSig = generateMnemonic(wordlist);
const bundleText = 'descriptor=tr(TEST_VERIFY_PAYLOAD); policy=or(thresh(2,pk(A),pk(B)),and(after(500000),pk(C)))';

const secret = generateLegacySecret();
const sealed = await sealBundle(bundleText, secret);
const { onChainShare, fastPathShare, fallbackShares } = await splitLegacySecretHybrid(secret, 3);
const lockA = deriveLegacyLockBytes(mnemonicA, network, vaultId, roleA);
const lockB = deriveLegacyLockBytes(mnemonicB, network, vaultId, roleB);
const lockFast = deriveLegacyLockBytes(mnemonicFast, network, vaultId, roleFast);
const lockedFastShare = lockShare(fastPathShare, lockFast);
const lockedFallbackA = lockShare(fallbackShares[0], lockA);
const lockedFallbackB = lockShare(fallbackShares[1], lockB);

// Signature-locked fast share: same fastPathShare, locked with a value
// derived from a deterministic signature over legacyUnlockMessage instead
// of a raw mnemonic derivation -- the hardware-wallet-compatible path.
const signature = signLegacyUnlockMessage(mnemonicSig, network, derivationPathSig, vaultId, roleSig);
const lockSig = deriveLegacyLockBytesFromSignature(signature, vaultId, roleSig);
const lockedFastShareSig = lockShare(fastPathShare, lockSig);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.goto('file://' + new URL('../apps/web/public/dynastytrust-legacy-recovery-tool.html', import.meta.url).pathname);

// ── Fast path ───────────────────────────────────────────────────────────
await page.fill('#fp-mnemonic', mnemonicFast);
await page.selectOption('#fp-network', network);
await page.fill('#fp-vault-id', vaultId);
await page.fill('#fp-key-role', roleFast);
await page.fill('#fp-locked-share', b64(lockedFastShare));
await page.fill('#fp-onchain-share', b64(onChainShare));
await page.fill('#fp-nonce', sealed.nonceB64);
await page.fill('#fp-ciphertext', sealed.ciphertextB64);
await page.click('#fp-run');
await page.waitForTimeout(300);
const fastResult = await page.inputValue('#result');
if (fastResult !== bundleText) {
  console.error('FAST PATH MISMATCH'); console.error('expected:', bundleText); console.error('got:     ', fastResult);
  await browser.close();
  process.exit(1);
}
console.log('standalone tool fast-path recovery verified: byte-identical match');

// ── Fast path, signature-based (hardware-wallet-compatible) ──────────────
await page.click('#tab-fast-sig');
await page.fill('#fs-vault-id', vaultId);
await page.fill('#fs-key-role', roleSig);
await page.fill('#fs-signature', b64(signature));
await page.fill('#fs-locked-share', b64(lockedFastShareSig));
await page.fill('#fs-onchain-share', b64(onChainShare));
await page.fill('#fs-nonce', sealed.nonceB64);
await page.fill('#fs-ciphertext', sealed.ciphertextB64);
await page.click('#fs-run');
await page.waitForTimeout(300);
const fastSigResult = await page.inputValue('#result');
if (fastSigResult !== bundleText) {
  console.error('SIGNATURE FAST PATH MISMATCH'); console.error('expected:', bundleText); console.error('got:     ', fastSigResult);
  await browser.close();
  process.exit(1);
}
console.log('standalone tool signature-based fast-path recovery verified: byte-identical match');

// ── Fallback path (two different keyholders, on-chain pad unused) ────────
await page.click('#tab-fallback');
await page.fill('#fb-mnemonic-a', mnemonicA);
await page.selectOption('#fb-network-a', network);
await page.fill('#fb-vault-id-a', vaultId);
await page.fill('#fb-key-role-a', roleA);
await page.fill('#fb-locked-share-a', b64(lockedFallbackA));
await page.fill('#fb-mnemonic-b', mnemonicB);
await page.selectOption('#fb-network-b', network);
await page.fill('#fb-vault-id-b', vaultId);
await page.fill('#fb-key-role-b', roleB);
await page.fill('#fb-locked-share-b', b64(lockedFallbackB));
await page.fill('#fb-nonce', sealed.nonceB64);
await page.fill('#fb-ciphertext', sealed.ciphertextB64);
await page.click('#fb-run');
await page.waitForTimeout(300);
const fallbackResult = await page.inputValue('#result');
await browser.close();

if (fallbackResult !== bundleText) {
  console.error('FALLBACK PATH MISMATCH'); console.error('expected:', bundleText); console.error('got:     ', fallbackResult);
  process.exit(1);
}
console.log('standalone tool fallback-path recovery verified: byte-identical match');
