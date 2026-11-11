/**
 * test-recovery-instructions.mjs -- the recovery steps printed in every
 * vault backup (apps/web/src/lib/recovery-instructions.ts) may only name
 * Bitcoin Core commands that scripts/bitcoin-core-proof.mjs actually
 * runs, and must not send a family to a wallet nobody has seen load a
 * vault. Until 2026-11-11 the backup recommended Sparrow, unproven.
 * Wired into `npm test`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coreRecoveryLines, coreNetworkFlag } from '../apps/web/src/lib/recovery-instructions.ts';
import { vaultBackupText, legacyOnChainRecoveryNoteText } from '../apps/web/src/lib/descriptor-backup.ts';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const proof = readFileSync(new URL('./bitcoin-core-proof.mjs', import.meta.url), 'utf8');

// 1. Every command the instructions name is one the proof runs.
const text = coreRecoveryLines('bitcoin').join('\n');
const named = [...new Set(text.match(/\b(getdescriptorinfo|createwallet|importdescriptors|listunspent|createpsbt|walletprocesspsbt|combinepsbt|finalizepsbt|sendrawtransaction|[a-z]+psbt|[a-z]{6,}descriptors?)\b/g))];
assert.ok(named.length >= 9, `expected the nine commands, found ${named}`);
for (const c of named) assert.ok(proof.includes(`'${c}'`), `the instructions name "${c}", which the Bitcoin Core proof never runs`);
assert.ok(proof.includes('sequence: 4294967294') && text.includes('"sequence":4294967294'));
pass(`all ${named.length} Bitcoin Core commands in the instructions are run by the proof`);

// 2. The right network flag, on every command line.
assert.equal(coreNetworkFlag('bitcoin'), ''); assert.equal(coreNetworkFlag('signet'), ' -signet'); assert.equal(coreNetworkFlag('testnet'), ' -testnet');
for (const l of coreRecoveryLines('signet').filter(l => l.includes('bitcoin-cli'))) assert.ok(l.includes('bitcoin-cli -signet '), l);
assert.ok(!text.includes('-signet') && !text.includes('-testnet'));
pass('signet and testnet vaults get their flag on every command; real-bitcoin vaults get none');

// 3. No backup recommends an unproven wallet; each says so plainly.
const vault = { name: 'Family', network: 'bitcoin', address_type: 'tr_multileaf', address: 'bc1pexample', descriptor: 'tr(k,pk(x))', miniscript_policy: 'p',
  leaves: [{ id: 'a', label: 'Everyday', keys: ['02' + 'a'.repeat(64)], quorum: 1, unlock: { type: 'immediate' }, decay: null }] };
const docs = [vaultBackupText(vault), legacyOnChainRecoveryNoteText({ vaultName: 'Family', network: 'bitcoin', roleLabel: 'Founder', address: 'bc1q', derivationPath: "m/84'/0'/900000'/1/0", txid: null })];
for (const d of docs) {
  assert.ok(!/recommended/i.test(d.split('\n').filter(l => /sparrow|nunchuk/i.test(l)).join(' ')), 'a backup recommends Sparrow or Nunchuk');
  assert.ok(!/Sparrow sets/i.test(d) && !/Import Wallet/i.test(d));
  assert.ok(d.includes('BITCOIN CORE (the proven way)') && d.includes('importdescriptors') && d.includes('Nothing sets the locktime for you'));
  assert.ok(/SPARROW:[\s\S]*Do not count on it/.test(d) && /NUNCHUK:[\s\S]*Do not count on it/.test(d));
  assert.ok(!/[^\x00-\x7F]/.test(d), 'non-ASCII in a backup file');
  assert.ok(!/at least one signer's/i.test(d), 'one seed is not enough to spend');
}
pass('the vault backup and the on-chain recovery note name Bitcoin Core, say the locktime is manual, and tell people not to count on Sparrow or Nunchuk');

console.log(`recovery-instructions tests passed (${n} cases)`);
