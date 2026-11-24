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
import { coreRecoveryLines, coreRangedRecoveryLines, coreNetworkFlag } from '../apps/web/src/lib/recovery-instructions.ts';
import { vaultBackupText, legacyOnChainRecoveryNoteText, legacyOnChainDescriptorPayload, backupDescriptor } from '../apps/web/src/lib/descriptor-backup.ts';

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

// 4. A vault with a new address every time (ranged slice 6): its steps name
// only commands scripts/bitcoin-core-ranged-proof.mjs runs, with the same
// import arguments, and every backup carries the descriptor of EVERY address.
{
  const rproof = readFileSync(new URL('./bitcoin-core-ranged-proof.mjs', import.meta.url), 'utf8');
  const rtext = coreRangedRecoveryLines('bitcoin').join('\n');
  const rnamed = [...new Set(rtext.match(/\b(getdescriptorinfo|createwallet|importdescriptors|listunspent|createpsbt|walletprocesspsbt|combinepsbt|finalizepsbt|sendrawtransaction)\b/g))];
  assert.ok(rnamed.length >= 9, `found ${rnamed}`);
  for (const c of rnamed) assert.ok(rproof.includes(`'${c}'`), `the fresh-address steps name "${c}", which the ranged Core proof never runs`);
  assert.ok(rtext.includes('"range":[0,999],"active":true') && rproof.includes('range: [0, 999], active: true'), 'the import arguments must be the ones the proof used');
  assert.ok(rproof.includes('sequence: QUIET') && /sequence" is the path's/.test(rtext), 'the "if untouched" step must be the one the proof ran');
  for (const l of coreRangedRecoveryLines('signet').filter(l => l.includes('bitcoin-cli'))) assert.ok(l.includes('bitcoin-cli -signet'), l);

  const MP = "tr(50929b,{multi_a(2,[aabbccdd/48'/1'/0'/2']tpubA/<0;1>/*,[11223344/48'/1'/0'/2']tpubB/<0;1>/*)})#abcd1234";
  const v2 = { name: 'Fresh', network: 'bitcoin', address_type: 'tr_multileaf', address: 'bc1pfirst', descriptor: "tr(50929b,{multi_a(2,[aabbccdd/48'/1'/0'/2']tpubA/0/0)})#oldform1", miniscript_policy: 'p',
    descriptor_version: 2, descriptor_multipath: MP,
    leaves: [{ id: 'a', label: 'Everyday', keys: ['02' + 'a'.repeat(64)], quorum: 1, unlock: { type: 'immediate' }, decay: null }] };
  const t = vaultBackupText(v2);
  assert.ok(t.includes(MP), 'the backup must carry the every-address descriptor');
  assert.ok(!t.includes('#oldform1'), 'the one-address descriptor must not be the one a fresh-address backup carries');
  assert.ok(/NEW ADDRESS/.test(t) && t.includes('# First receive address'));
  assert.ok(t.includes('"range":[0,999],"active":true') && !t.includes('keep the [bracket] in front of it and the /0/0'));
  assert.ok(!/[^\x00-\x7F]/.test(t));
  assert.equal(legacyOnChainDescriptorPayload(v2), MP);
  assert.equal(backupDescriptor({ descriptor: 'x', descriptor_version: 1 }), 'x');
  assert.throws(() => vaultBackupText({ ...v2, descriptor_multipath: null }), /would miss coins/);
  assert.throws(() => legacyOnChainDescriptorPayload({ ...v2, descriptor_multipath: null }), /would miss coins/);
  const note = legacyOnChainRecoveryNoteText({ vaultName: 'Fresh', network: 'bitcoin', roleLabel: 'Founder', address: 'bc1q', derivationPath: "m/84'/0'/900000'/1/0", txid: null, freshAddresses: true });
  assert.ok(note.includes('"range":[0,999],"active":true'));
  // A one-address vault's backup is unchanged in form.
  assert.ok(vaultBackupText(vault).includes('# Receive address') && !vaultBackupText(vault).includes('"range"'));
  pass('fresh-address vaults: the steps are the ones the ranged Core proof ran; the backup, the on-chain payload and the recovery note carry the descriptor of every address, and refuse to be made without it');
}

// 5. The backup PDF of a fresh-address vault prints the descriptor of every
// address and its fingerprint, and refuses to be made without it.
{
  const { inflateSync } = await import('node:zlib');
  const { buildVaultPDF } = await import('../apps/web/src/lib/reports/vault-pdf.js');
  const { formatDescriptorFingerprint } = await import('../apps/web/src/lib/descriptor-fingerprint.ts');
  const MP = "tr(50929b,{multi_a(2,[aabbccdd/48'/1'/0'/2']tpubA/<0;1>/*)})#abcd1234";
  const base = { name: 'F', network: 'signet', status: 'compiled', address_type: 'tr_multileaf', address: 'tb1p' + 'q'.repeat(58),
    descriptor: 'tr(old)#oldform1', miniscript_policy: 'p', founder_keys: [], heir_keys: [], created_at: '2026-11-01T00:00:00Z',
    leaves: [{ id: 'a', label: 'Everyday', keys: ['02'.padEnd(66, 'a')], quorum: 1, unlock: { type: 'immediate' } }] };
  const textOf = (bytes) => {
    const raw = Buffer.from(bytes);
    const out = [];
    let at = 0;
    while ((at = raw.indexOf('stream', at)) !== -1) {
      const start = raw[at + 6] === 0x0d ? at + 8 : at + 7;
      const end = raw.indexOf('endstream', start);
      try { out.push(inflateSync(raw.subarray(start, end)).toString('latin1')); } catch { /* not a flate stream */ }
      at = end + 'endstream'.length;
    }
    const content = out.join('\n');
    // pdf-lib writes standard-font text as <hex> strings.
    return content + content.replace(/<([0-9A-Fa-f]+)>/g, (_, h) => Buffer.from(h, 'hex').toString('latin1'));
  };
  const fresh = textOf(await buildVaultPDF({ ...base, descriptor_version: 2, descriptor_multipath: MP }));
  assert.ok(fresh.includes("tpubA/<0;1>/*"), 'the PDF must print the every-address descriptor');
  assert.ok(!fresh.includes('oldform1'), 'the PDF must not print the one-address descriptor for a fresh-address vault');
  const fp = formatDescriptorFingerprint(MP).replace(/^.*?([0-9A-F]{4}[- ]?[0-9A-F]{4}).*$/i, '$1');
  assert.ok(fresh.includes(fp), `the PDF must print the every-address fingerprint (${fp})`);
  assert.ok(fresh.includes('FIRST BITCOIN ADDRESS'));
  await assert.rejects(() => buildVaultPDF({ ...base, descriptor_version: 2, descriptor_multipath: null }), /would miss coins/);
  const old = textOf(await buildVaultPDF(base));
  assert.ok(old.includes('oldform1') && !old.includes('FIRST BITCOIN ADDRESS'));
  pass('the backup PDF of a fresh-address vault prints the every-address descriptor and its fingerprint, says the address is only the first, and refuses without the descriptor; a one-address PDF is unchanged');
}

console.log(`recovery-instructions tests passed (${n} cases)`);
