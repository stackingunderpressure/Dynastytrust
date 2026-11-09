/**
 * offline-vault-harness.mjs -- deterministic, offline, end-to-end proof that
 * EVERY vault shape's EVERY spending path produces a valid, finalizable Bitcoin
 * transaction -- using the REAL Rust compiler (run locally, not Fly) and the
 * REAL browser signer (apps/web/src/lib/psbt-signer.ts).
 *
 * No network, no Bitcoin node. The rust-miniscript finalizer only finalizes a
 * PSBT when the signatures genuinely satisfy the leaf script (including its
 * timelock), so "finalize succeeds and a well-formed tx comes out" is a real
 * correctness proof. Timelocks are proven without waiting by asserting the
 * absolute unlock height is baked into the finalized tx's nLockTime (a node
 * then enforces it), and gates are proven by asserting below-quorum, wrong-
 * signer, and missing-consent spends are REJECTED.
 *
 * Shapes covered:
 *   named-field (/compile):   family-inheritance, lost-device, social-recovery,
 *                             backup ("anytime harder"), second-inheritance
 *   bloc (/compile-bloc):     parents_now, coparent_kids, parent_solo, and the
 *                             kids_decay ladder at three rungs
 *   tranche (/compile-tranche): trustee (anytime) and beneficiary (unlock_block)
 *
 * Run:  npm run test:harness   (one command -- builds + starts the compiler,
 *       runs this, tears it down). Or manually with COMPILER_URL/COMPILER_SECRET.
 */

import assert from 'node:assert/strict';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import * as btc from '@scure/btc-signer';
import { signPsbtWithMnemonic, mergePsbts, verifyPsbtMatchesRequest } from '../apps/web/src/lib/psbt-signer.ts';

const COMPILER = process.env.COMPILER_URL || 'http://127.0.0.1:8899';
const SECRET = process.env.COMPILER_SECRET || 'testsecret';
const NET = 'signet';

// One fixed mnemonic, many accounts -> many distinct signers. Signer N is
// account m/86'/1'/N'; the browser signer signs with that path's /0/0 child,
// so the pubkey the compiler bakes into the leaf is that same /0/0 child.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ROOT = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC), { private: 0x04358394, public: 0x043587cf });

const toHex = (b) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
function signer(n) {
  const path = `m/86'/1'/${n}'`;
  return { path, pubkey: toHex(ROOT.derive(path).deriveChild(0).deriveChild(0).publicKey) };
}
const S = Array.from({ length: 10 }, (_, i) => signer(i));
const keys = (...idx) => idx.map(i => S[i].pubkey);
const who = (...idx) => idx.map(i => S[i]);

async function post(endpoint, body) {
  const res = await fetch(`${COMPILER}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(`${endpoint} -> ${res.status}: ${json.error || JSON.stringify(json)}`);
  return json;
}

function scriptPubKeyHex(address) {
  return toHex(btc.OutScript.encode(btc.Address(btc.TEST_NETWORK).decode(address)));
}

// nLockTime is the last 4 bytes of a raw tx, little-endian.
const lockTimeOf = (raw) => parseInt(raw.slice(-8).match(/../g).reverse().join(''), 16);

const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const SPEND = { destination: DEST, amount_sats: 900_000, fee_sats: 20_000 };

// Shared cycle: (compile endpoint, compile body) -> (psbt endpoint, psbt body
// builder) -> sign with the real signer -> finalize. Returns raw tx hex.
async function cycle({ label, compileEp, compileBody, psbtEp, psbtBody, signers }) {
  const compiled = await post(compileEp, compileBody);
  assert.ok(compiled.descriptor && compiled.address, `${label}: compile returned no descriptor/address`);
  const utxo = { txid: '00'.repeat(32), vout: 0, value_sats: 1_000_000, script_pubkey: scriptPubKeyHex(compiled.address) };
  const bin = await post(psbtEp, { ...psbtBody, ...SPEND, inputs: [utxo], change_address: compiled.address, network: NET });
  assert.ok(bin.psbt_hex, `${label}: psbt returned no psbt_hex`);
  const signed = [];
  for (const s of signers) signed.push((await signPsbtWithMnemonic(bin.psbt_hex, MNEMONIC, s.path, 'testnet')).psbt_hex);
  const merged = signed.length > 1 ? mergePsbts(signed) : signed[0];
  const fin = await post('/psbt-finalize', { psbt_hex: merged });
  const raw = fin.raw_tx_hex;
  assert.ok(raw && raw.length > 20, `${label}: finalize returned no raw tx`);
  return raw;
}

// Named-field vault: forward EVERY policy param so the compiler re-derives the
// identical address (it safety-checks change_address against the policy).
const spendNamed = ({ label, policy, path, signers }) => cycle({
  label, compileEp: '/compile', compileBody: { ...policy, address_type: 'tr_multileaf', network: NET },
  psbtEp: '/psbt-binary', psbtBody: { ...policy, path, address_type: 'tr_multileaf' }, signers,
});
const spendBloc = ({ label, policy, path, quorum = 0, signers }) => cycle({
  label, compileEp: '/compile-bloc', compileBody: { ...policy, network: NET },
  psbtEp: '/psbt-binary-bloc', psbtBody: { ...policy, path, quorum }, signers,
});
const spendTranche = ({ label, policy, path, signers }) => cycle({
  label, compileEp: '/compile-tranche', compileBody: { ...policy, network: NET },
  psbtEp: '/psbt-binary-tranche', psbtBody: { ...policy, path }, signers,
});

async function expectFail(fn, args) {
  let threw = false;
  try { await fn(args); } catch { threw = true; }
  assert.ok(threw, `${args.label}: expected this spend to be REJECTED, but it finalized`);
}

// Assert a positive spend finalized with the expected nLockTime.
async function ok(fn, args, expectLock) {
  const raw = await fn(args);
  assert.equal(lockTimeOf(raw), expectLock, `${args.label}: lock_time ${lockTimeOf(raw)} != expected ${expectLock}`);
  console.log(`  [ok] ${args.label} -> finalized, lock_time ${lockTimeOf(raw)}`);
}
const rejected = (msg) => console.log(`  [ok] REJECTED as it should be: ${msg}`);

// ── family-inheritance: founders 2-of-3, heirs 2-of-3, recovery + inheritance ─
{
  const p = { founder_keys: keys(0,1,2), founder_quorum: 2, recovery_quorum: 2,
              heir_keys: keys(3,4,5), heir_quorum: 2, recovery_after: 900_000, inheritance_after: 950_000 };
  console.log('family-inheritance');
  await ok(spendNamed, { label: 'family / founders-now', policy: p, path: 'founders_now', signers: who(0,1) }, 0);
  await ok(spendNamed, { label: 'family / recovery', policy: p, path: 'recovery', signers: who(0,1) }, p.recovery_after);
  await ok(spendNamed, { label: 'family / inheritance (heirs alone)', policy: p, path: 'inheritance', signers: who(3,4) }, p.inheritance_after);
  await expectFail(spendNamed, { label: 'family / founders-now with 1 of 2', policy: p, path: 'founders_now', signers: who(0) }); rejected('1 of 2 founders');
  await expectFail(spendNamed, { label: 'family / founders door signed by heirs', policy: p, path: 'founders_now', signers: who(3,4) }); rejected('heirs on the founders door');
  const c = { ...p, consent_keys: keys(5), consent_quorum: 1 };
  await ok(spendNamed, { label: 'family+consent / founders-now with beneficiary', policy: c, path: 'founders_now', signers: who(0,1,5) }, 0);
  await expectFail(spendNamed, { label: 'family+consent / founders-now WITHOUT beneficiary', policy: c, path: 'founders_now', signers: who(0,1) }); rejected('consent gate freezes without the beneficiary');
}

// ── lost-device: one person, 3 devices, 2-of-3 now, 1 device alone after recovery ─
{
  const p = { founder_keys: keys(0,1,2), founder_quorum: 2, recovery_quorum: 1,
              heir_keys: keys(3), heir_quorum: 1, recovery_after: 900_000, inheritance_after: 950_000 };
  console.log('lost-device');
  await ok(spendNamed, { label: 'lost-device / 2 of 3 devices now', policy: p, path: 'founders_now', signers: who(0,1) }, 0);
  await ok(spendNamed, { label: 'lost-device / 1 surviving device after timelock', policy: p, path: 'recovery', signers: who(0) }, p.recovery_after);
  await ok(spendNamed, { label: 'lost-device / heir inherits', policy: p, path: 'inheritance', signers: who(3) }, p.inheritance_after);
  await expectFail(spendNamed, { label: 'lost-device / 1 device before timelock (founders path)', policy: p, path: 'founders_now', signers: who(0) }); rejected('a single device cannot spend the everyday path');
}

// ── social-recovery: you 2-of-3 now; 3-of-5 trusted peers after the long wait ─
{
  const p = { founder_keys: keys(0,1,2), founder_quorum: 2, recovery_quorum: 2,
              heir_keys: keys(3,4,5,6,7), heir_quorum: 3, recovery_after: 900_000, inheritance_after: 950_000 };
  console.log('social-recovery');
  await ok(spendNamed, { label: 'social / your 2 of 3 now', policy: p, path: 'founders_now', signers: who(0,1) }, 0);
  await ok(spendNamed, { label: 'social / your own recovery', policy: p, path: 'recovery', signers: who(0,1) }, p.recovery_after);
  await ok(spendNamed, { label: 'social / 3 of 5 peers rescue', policy: p, path: 'inheritance', signers: who(3,4,5) }, p.inheritance_after);
  await expectFail(spendNamed, { label: 'social / only 2 of 5 peers', policy: p, path: 'inheritance', signers: who(3,4) }); rejected('2 of 5 peers is below the social quorum');
}

// ── backup ("anytime, harder"): separate backup keys, no timelock, replaces recovery ─
{
  const p = { founder_keys: keys(0,1,2), founder_quorum: 2, recovery_after: 0,
              backup_keys: keys(3,4,5), backup_quorum: 2,
              heir_keys: keys(6,7), heir_quorum: 1, inheritance_after: 950_000 };
  console.log('backup (anytime harder)');
  await ok(spendNamed, { label: 'backup / founders-now', policy: p, path: 'founders_now', signers: who(0,1) }, 0);
  await ok(spendNamed, { label: 'backup / 2 of 3 backup keys, no timelock', policy: p, path: 'backup', signers: who(3,4) }, 0);
  await ok(spendNamed, { label: 'backup / inheritance', policy: p, path: 'inheritance', signers: who(6) }, p.inheritance_after);
  await expectFail(spendNamed, { label: 'backup / 1 of 2 backup keys', policy: p, path: 'backup', signers: who(3) }); rejected('1 of 2 backup keys');
}

// ── second-inheritance: a second heir cohort with its own, later absolute date ─
{
  const p = { founder_keys: keys(0,1,2), founder_quorum: 2, recovery_quorum: 2,
              heir_keys: keys(3,4,5), heir_quorum: 2, recovery_after: 900_000, inheritance_after: 950_000,
              second_heir_keys: keys(6,7), second_heir_quorum: 1, second_inheritance_after: 1_000_000 };
  console.log('second-inheritance');
  await ok(spendNamed, { label: 'second-inh / primary heirs', policy: p, path: 'inheritance', signers: who(3,4) }, p.inheritance_after);
  await ok(spendNamed, { label: 'second-inh / second cohort alone, later date', policy: p, path: 'second_inheritance', signers: who(6) }, p.second_inheritance_after);
  await expectFail(spendNamed, { label: 'second-inh / second cohort on the primary door', policy: p, path: 'inheritance', signers: who(6,7) }); rejected('second cohort cannot open the primary inheritance door');
}

// ── Dynasty Bloc: 2 parents, 3 kids, decaying kids ladder ─────────────────────
{
  const p = { parent_keys: keys(0,1), parents_together_quorum: 2, coparent_quorum: 1,
              kid_keys: keys(2,3,4), kids_with_parent_quorum: 3,
              parent_solo_after: 900_000, parent_solo_quorum: 1,
              kids_decay_start_after: 950_000, kids_decay_step_blocks: 52_560,
              kids_decay_start_quorum: 3, kids_decay_floor_quorum: 1 };
  const rung = (q) => p.kids_decay_start_after + (p.kids_decay_start_quorum - q) * p.kids_decay_step_blocks;
  console.log('dynasty-bloc');
  await ok(spendBloc, { label: 'bloc / parents together now', policy: p, path: 'parents_now', signers: who(0,1) }, 0);
  await ok(spendBloc, { label: 'bloc / one parent + every kid now', policy: p, path: 'coparent_kids', signers: who(0,2,3,4) }, 0);
  await ok(spendBloc, { label: 'bloc / one parent alone after timelock', policy: p, path: 'parent_solo', signers: who(0) }, p.parent_solo_after);
  await ok(spendBloc, { label: 'bloc / kids 3-of-3 (first rung)', policy: p, path: 'kids_decay', quorum: 3, signers: who(2,3,4) }, rung(3));
  await ok(spendBloc, { label: 'bloc / kids 2-of-3 (decayed one rung)', policy: p, path: 'kids_decay', quorum: 2, signers: who(2,3) }, rung(2));
  await ok(spendBloc, { label: 'bloc / kids 1-of-3 (floor rung)', policy: p, path: 'kids_decay', quorum: 1, signers: who(2) }, rung(1));
  await expectFail(spendBloc, { label: 'bloc / nonexistent 9-of-3 rung', policy: p, path: 'kids_decay', quorum: 9, signers: who(2,3,4) }); rejected('a decay rung that does not exist');
  await expectFail(spendBloc, { label: 'bloc / one parent on the parents-together door', policy: p, path: 'parents_now', signers: who(0) }); rejected('one parent cannot open the parents-together door');
}

// ── Tranche (T-vesting): trustees anytime; beneficiary alone after unlock_block ─
{
  const p = { beneficiary_key: S[5].pubkey, trustee_keys: keys(0,1,2), trustee_quorum: 2, unlock_block: 900_000 };
  console.log('tranche');
  await ok(spendTranche, { label: 'tranche / trustees escape hatch, anytime', policy: p, path: 'trustee', signers: who(0,1) }, 0);
  await ok(spendTranche, { label: 'tranche / beneficiary alone after unlock', policy: p, path: 'beneficiary', signers: who(5) }, p.unlock_block);
  await expectFail(spendTranche, { label: 'tranche / trustee on the beneficiary door', policy: p, path: 'beneficiary', signers: who(0,1) }); rejected('a trustee cannot claim the beneficiary tranche');
}

// ── Browser no-rogue-signing gate: what a dishonest coordinator cannot get signed ─
// The compiler builds an honest PSBT; the harness then forges the bytes a
// compromised Netlify function / Supabase row / compiler could hand the
// browser and proves verifyPsbtMatchesRequest refuses each one using only the
// PSBT's own witness UTXOs and the vault's own address -- never the server's
// summary. Same-length byte substitution keeps every PSBT length prefix valid.
{
  const p = { founder_keys: keys(0,1,2), founder_quorum: 2, recovery_quorum: 2,
              heir_keys: keys(3,4,5), heir_quorum: 2, recovery_after: 900_000, inheritance_after: 950_000 };
  const compiled = await post('/compile', { ...p, address_type: 'tr_multileaf', network: NET });
  const own = compiled.address;
  const ownScript = scriptPubKeyHex(own);
  const utxo = { txid: '00'.repeat(32), vout: 0, value_sats: 1_000_000, script_pubkey: ownScript };
  const honest = (await post('/psbt-binary', { ...p, path: 'founders_now', address_type: 'tr_multileaf', ...SPEND, inputs: [utxo], change_address: own, network: NET })).psbt_hex;
  const shown = { destination: DEST, amountSats: SPEND.amount_sats, network: NET, ownAddress: own, feeSats: SPEND.fee_sats, changeSats: 1_000_000 - SPEND.amount_sats - SPEND.fee_sats };
  const attackerScript = '5120' + S[9].pubkey.slice(2); // a P2TR script nobody in this vault controls
  const le64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return toHex(b); };
  const swapOnce = (hex, from, to) => { const i = hex.indexOf(from); assert.ok(i >= 0 && hex.indexOf(from, i + 1) < 0, 'forge target must occur exactly once'); return hex.slice(0, i) + to + hex.slice(i + from.length); };
  const refuses = (label, psbt, req, needle) => {
    const r = verifyPsbtMatchesRequest(psbt, req);
    assert.equal(r.ok, false, `${label}: the gate ACCEPTED a forged PSBT`);
    assert.ok(r.reason.includes(needle), `${label}: refused for the wrong reason: ${r.reason}`);
    rejected(label);
  };
  console.log('browser gate');
  assert.equal(verifyPsbtMatchesRequest(honest, shown).ok, true, 'gate refused the honest PSBT');
  console.log('  [ok] gate / honest PSBT passes with inputs, change and fee all verified from its bytes');
  // change output redirected to an attacker (unsigned tx output[1] = change amount || 0x22 || script)
  refuses('gate / change redirected to an attacker address', swapOnce(honest, le64(shown.changeSats) + '22' + ownScript, le64(shown.changeSats) + '22' + attackerScript), shown, 'change output does not return');
  // input swapped for a coin that is not this vault's (witness_utxo = amount || 0x22 || script)
  refuses('gate / input that is not this vault\'s coin', swapOnce(honest, le64(1_000_000) + '22' + ownScript, le64(1_000_000) + '22' + attackerScript), shown, 'does not spend this vault');
  // the summary lies about the fee / the change while the bytes stay honest
  refuses('gate / fee shown is not the real fee', honest, { ...shown, feeSats: SPEND.fee_sats - 1_000 }, 'real fee');
  refuses('gate / change shown as zero while the PSBT has change', honest, { ...shown, changeSats: 0 }, 'no change was shown');
  refuses('gate / destination shown is not the one paid', honest, { ...shown, destination: own }, 'destination does not match');
  // belt and braces: the compiler itself refuses the same two forgeries server-side
  await expectFail(async () => post('/psbt-binary', { ...p, path: 'founders_now', address_type: 'tr_multileaf', ...SPEND, inputs: [{ ...utxo, script_pubkey: attackerScript }], change_address: own, network: NET }), { label: 'compiler / foreign input' }); rejected('compiler refuses a foreign input');
  await expectFail(async () => post('/psbt-binary', { ...p, path: 'founders_now', address_type: 'tr_multileaf', ...SPEND, inputs: [utxo], change_address: DEST, network: NET }), { label: 'compiler / foreign change' }); rejected('compiler refuses change to a foreign address');
}

console.log('\noffline-vault-harness OK -- every door of every shape proven end to end');
console.log('(real Rust compiler + real browser signer + real rust-miniscript finalizer; timelocks baked in, quorum/consent/cohort gates enforced)');
