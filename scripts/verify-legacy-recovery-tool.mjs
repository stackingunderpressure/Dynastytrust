// One-off verification (not part of `npm test`): loads the built
// standalone recovery tool in a real headless browser and drives it
// end to end against a REAL signed Bitcoin transaction's OP_RETURN
// output, confirming the bundled artifact actually recovers the exact
// bundle text -- not just that it builds without errors. Run manually:
// node --experimental-strip-types --import
// ./scripts/register-ts-resolver.mjs scripts/verify-legacy-recovery-tool.mjs
import playwright from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = playwright;
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import * as btc from '@scure/btc-signer';
import { signLegacyOnChainUnlock } from '../apps/web/src/lib/legacy-recovery.ts';
import { sealOnChainPayload, toPublishNetwork } from '../apps/web/src/lib/legacy-onchain-recovery.ts';
import { buildAndSignPublishTx } from '../apps/web/src/lib/onchain-publish.ts';

const network = 'testnet';
const vaultIndex = 0;
const mnemonic = generateMnemonic(wordlist);
const payerMnemonic = generateMnemonic(wordlist); // a totally unrelated, separately funded key
const payerDerivationPath = "m/86'/1'/0'";
const bundleText = 'descriptor=tr(TEST_VERIFY_PAYLOAD); policy=or(thresh(2,pk(A),pk(B)),and(after(500000),pk(C)))';

// Seal the payload, then build a real signed publish transaction paid
// for by a totally separate key -- exactly as the app's guided flow
// does. The identity key never signs a transaction, only ever the
// message signed below for recovery.
const { payloadHex, address } = await sealOnChainPayload({ bundleText, mnemonic, network, vaultIndex });
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

// Independently re-derive the recovery signature -- not reused from
// sealing -- exactly what a real recovery does decades later.
const recoverySignature = signLegacyOnChainUnlock(mnemonic, network, vaultIndex);
const sigHex = Array.from(recoverySignature).map(b => b.toString(16).padStart(2, '0')).join('');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.goto('file://' + new URL('../apps/web/public/dynastytrust-legacy-recovery-tool.html', import.meta.url).pathname);

await page.fill('#vault-index', String(vaultIndex));
await page.fill('#scriptpubkey', opReturnScriptHex);
await page.fill('#signature', sigHex);
await page.click('#run');
await page.waitForTimeout(300);
const result = await page.inputValue('#result');
await browser.close();

if (result !== bundleText) {
  console.error('RECOVERY MISMATCH'); console.error('expected:', bundleText); console.error('got:     ', result);
  process.exit(1);
}
console.log('standalone tool recovery verified against a real signed transaction: byte-identical match');
