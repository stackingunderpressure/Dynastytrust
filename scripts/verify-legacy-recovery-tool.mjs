// One-off verification (not part of `npm test`): loads the built
// standalone recovery tool in a real headless browser and drives it
// end to end against a REAL signed Bitcoin transaction's OP_RETURN
// output, confirming the bundled artifact actually recovers the exact
// bundle text -- not just that it builds without errors. Drives the
// tool's real field order: paste the scriptPubKey first (the tool
// decodes it and computes the message to sign from the nonce found
// inside), then sign, then recover. Also proves the tool's fallback
// path: someone pastes the raw payload hex (what DynastyTrust's "Seal
// payload" step shows) directly into that field instead of a real
// scriptPubKey -- easy to do since the two hex strings look identical
// at a glance -- and recovery still works. Run manually:
// node --experimental-strip-types --import
// ./scripts/register-ts-resolver.mjs scripts/verify-legacy-recovery-tool.mjs
import playwright from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = playwright;
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import * as btc from '@scure/btc-signer';
import { signLegacyOnChainNonce, unb64 } from '../apps/web/src/lib/legacy-recovery.ts';
import { sealOnChainPayload, toPublishNetwork, extractOnChainCandidates } from '../apps/web/src/lib/legacy-onchain-recovery.ts';
import { buildAndSignPublishTx } from '../apps/web/src/lib/onchain-publish.ts';

const network = 'testnet';
const mnemonic = generateMnemonic(wordlist);
const payerMnemonic = generateMnemonic(wordlist); // a totally unrelated, separately funded key
const payerDerivationPath = "m/86'/1'/0'";
const bundleText = 'descriptor=tr(TEST_VERIFY_PAYLOAD); policy=or(thresh(2,pk(A),pk(B)),and(after(500000),pk(C)))';

// Seal the payload (picks its own random nonce, signs it), then build a
// real signed publish transaction paid for by a totally separate key --
// exactly as the app's guided flow does. The identity key never signs a
// transaction, only ever the message signed below for recovery.
const { payloadHex, address } = await sealOnChainPayload({ bundleText, mnemonic, network });
const utxo = { txid: 'a'.repeat(64), vout: 0, valueSats: 20_000 };
const built = buildAndSignPublishTx({
  mnemonic: payerMnemonic,
  derivationPath: payerDerivationPath,
  network: toPublishNetwork(network),
  utxo,
  opReturnDataHex: payloadHex,
  feeRateSatsPerVb: 2,
  payTo: { address, amountSats: 1000 },
});

// Extract the OP_RETURN output's scriptPubKey hex from the real signed
// tx -- exactly what a person would copy from a block explorer.
const parsed = btc.Transaction.fromRaw(Uint8Array.from(Buffer.from(built.hex, 'hex')), {
  allowUnknownOutputs: true,
});
let opReturnScriptHex = null;
for (let i = 0; i < parsed.outputsLength; i++) {
  const out = parsed.getOutput(i);
  if (out.script.length > 0 && out.script[0] === 0x6a) {
    opReturnScriptHex = Array.from(out.script).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}
if (!opReturnScriptHex) {
  console.error('Could not find an OP_RETURN output in the built transaction.');
  process.exit(1);
}

// Independently re-derive the recovery signature over the nonce found
// in that same payload -- not reused from sealing -- exactly what a
// real recovery does decades later.
const candidates = extractOnChainCandidates([
  { txid: '0'.repeat(64), vout: [{ scriptpubkey_type: 'op_return', scriptpubkey: opReturnScriptHex }] },
]);
if (candidates.length === 0) {
  console.error('Could not decode the built OP_RETURN as a Legacy Recovery payload.');
  process.exit(1);
}
const foundNonce = unb64(candidates[0].sealed.nonceB64);
const recoverySignature = signLegacyOnChainNonce(mnemonic, network, foundNonce);
const sigHex = Array.from(recoverySignature).map(b => b.toString(16).padStart(2, '0')).join('');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const toolUrl = 'file://' + new URL('../apps/web/public/dynastytrust-legacy-recovery-tool.html', import.meta.url).pathname;

// ── Pass 1: the normal case -- paste the real scriptPubKey hex. ─────────
{
  const page = await browser.newPage();
  await page.goto(toolUrl);
  await page.fill('#scriptpubkey', opReturnScriptHex);
  await page.fill('#signature', sigHex);
  await page.click('#run');
  await page.waitForTimeout(300);
  const result = await page.inputValue('#result');
  await page.close();
  if (result !== bundleText) {
    console.error('SCRIPTPUBKEY-PATH MISMATCH'); console.error('expected:', bundleText); console.error('got:     ', result);
    process.exit(1);
  }
}

// ── Pass 2: the easy-to-make mistake -- paste the bare payload hex
// (what "Seal payload" shows) directly, instead of the real
// scriptPubKey. The tool must still recover via its fallback decode. ────
{
  const page = await browser.newPage();
  await page.goto(toolUrl);
  await page.fill('#scriptpubkey', payloadHex);
  await page.fill('#signature', sigHex);
  await page.click('#run');
  await page.waitForTimeout(300);
  const result = await page.inputValue('#result');
  await page.close();
  if (result !== bundleText) {
    console.error('RAW-PAYLOAD-PATH MISMATCH'); console.error('expected:', bundleText); console.error('got:     ', result);
    process.exit(1);
  }
}

// ── Pass 3: sign locally with a typed-in mnemonic instead of pasting a
// pre-computed signature -- the new "sign locally with this seed
// phrase" field, for a software-held key with no hardware wallet. ─────
{
  const page = await browser.newPage();
  await page.goto(toolUrl);
  await page.fill('#scriptpubkey', opReturnScriptHex);
  await page.fill('#sign-mnemonic', mnemonic);
  await page.click('#sign-mnemonic-button');
  await page.waitForTimeout(300);
  const filledSignature = await page.inputValue('#signature');
  if (filledSignature.toLowerCase() !== sigHex.toLowerCase()) {
    console.error('MNEMONIC-SIGN MISMATCH'); console.error('expected:', sigHex); console.error('got:     ', filledSignature);
    process.exit(1);
  }
  await page.click('#run');
  await page.waitForTimeout(300);
  const result = await page.inputValue('#result');
  await page.close();
  if (result !== bundleText) {
    console.error('MNEMONIC-SIGN-PATH RECOVERY MISMATCH'); console.error('expected:', bundleText); console.error('got:     ', result);
    process.exit(1);
  }
}

await browser.close();
console.log('standalone tool recovery verified against a real signed transaction (scriptPubKey, raw-payload, and local mnemonic-sign input): byte-identical match');
