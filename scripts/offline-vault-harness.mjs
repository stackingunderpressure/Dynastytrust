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
import { verifySignedPsbt } from '../netlify/functions/_psbt-verify.js';

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

// ── Server signature check: what signer-sessions will record as "signed" ─────
// netlify/functions/_psbt-verify.js against PSBTs from the real compiler,
// signed by the real browser signer: a genuine signature is accepted and
// counted; garbage, an unsigned PSBT, a signature for a different
// transaction, and a corrupted signature are all refused.
{
  const p = { founder_keys: keys(0,1,2), founder_quorum: 2, recovery_quorum: 2,
              heir_keys: keys(3,4,5), heir_quorum: 2, recovery_after: 900_000, inheritance_after: 950_000 };
  const compiled = await post('/compile', { ...p, address_type: 'tr_multileaf', network: NET });
  const utxo = { txid: '00'.repeat(32), vout: 0, value_sats: 1_000_000, script_pubkey: scriptPubKeyHex(compiled.address) };
  const build = async (amount, path = 'founders_now') => (await post('/psbt-binary', { ...p, path, address_type: 'tr_multileaf', ...SPEND, amount_sats: amount, inputs: [utxo], change_address: compiled.address, network: NET })).psbt_hex;
  const proposal = await build(900_000);
  const one = (await signPsbtWithMnemonic(proposal, MNEMONIC, S[0].path, 'testnet')).psbt_hex;
  const two = mergePsbts([one, (await signPsbtWithMnemonic(proposal, MNEMONIC, S[1].path, 'testnet')).psbt_hex]);
  const no = (label, args, needle) => {
    const r = verifySignedPsbt(args);
    assert.equal(r.ok, false, `${label}: accepted`);
    assert.ok(r.error.includes(needle), `${label}: wrong reason: ${r.error}`);
    rejected(label);
  };
  console.log('server signature check');
  assert.deepEqual(verifySignedPsbt({ psbtHex: one, proposalPsbtHex: proposal }), { ok: true, validSignatures: 1 });
  assert.deepEqual(verifySignedPsbt({ psbtHex: two, proposalPsbtHex: proposal }), { ok: true, validSignatures: 2 });
  console.log('  [ok] sigcheck / real signatures accepted and counted (1, then 2)');
  const rec = (await signPsbtWithMnemonic(await build(900_000, 'recovery'), MNEMONIC, S[0].path, 'testnet')).psbt_hex;
  assert.equal(verifySignedPsbt({ psbtHex: rec, proposalPsbtHex: await build(900_000, 'recovery') }).ok, true);
  console.log('  [ok] sigcheck / a timelocked-path signature verifies too');
  no('sigcheck / "00" is not a signature', { psbtHex: '00', proposalPsbtHex: proposal }, 'not a valid PSBT');
  no('sigcheck / an unsigned PSBT is not a signature', { psbtHex: proposal, proposalPsbtHex: proposal }, 'no valid signature');
  const other = (await signPsbtWithMnemonic(await build(800_000), MNEMONIC, S[0].path, 'testnet')).psbt_hex;
  no('sigcheck / a real signature for a DIFFERENT transaction', { psbtHex: other, proposalPsbtHex: proposal }, 'different transaction');
  // flip one byte inside the 64-byte signature (find it as the bytes the signed PSBT added)
  const sigStart = (() => { for (let i = 0; i < one.length; i++) if (one[i] !== proposal[i]) return i; })();
  const at = sigStart + 2 * 80; // well inside the tap_script_sig value
  const corrupted = one.slice(0, at) + (one[at] === 'f' ? '0' : 'f') + one.slice(at + 1);
  const r = verifySignedPsbt({ psbtHex: corrupted, proposalPsbtHex: proposal });
  assert.equal(r.ok, false, 'a corrupted signature was accepted');
  rejected('sigcheck / a corrupted signature');
}

// ── Adversarial review 2026-11-10: the attacks, kept as permanent checks ─────
// A co-signer or the server hands us a PSBT. These are the exact tricks the
// review demonstrated against the first versions of the signer, the merge and
// the server check.
{
  const { parsePsbt, serializePsbt, tapLeafHash, tapscriptSighash } = await import('../packages/bip341-psbt-signer/src/index.ts');
  const { schnorr } = await import('@noble/curves/secp256k1');
  const { countSignatures } = await import('../apps/web/src/lib/psbt-signer.ts');
  const fromHex = (h) => Uint8Array.from(h.match(/../g).map(b => parseInt(b, 16)));
  const p = { founder_keys: keys(0,1,2), founder_quorum: 2, recovery_quorum: 2,
              heir_keys: keys(3,4,5), heir_quorum: 2, recovery_after: 900_000, inheritance_after: 950_000 };
  const compiled = await post('/compile', { ...p, address_type: 'tr_multileaf', network: NET });
  const utxo = { txid: '00'.repeat(32), vout: 0, value_sats: 1_000_000, script_pubkey: scriptPubKeyHex(compiled.address) };
  const proposal = (await post('/psbt-binary', { ...p, path: 'founders_now', address_type: 'tr_multileaf', ...SPEND, inputs: [utxo], change_address: compiled.address, network: NET })).psbt_hex;
  const NUMS = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';
  // Insert raw key-value pairs at the start of input 0's map.
  const withInputKVs = (hex, kvs) => {
    const b = fromHex(hex); let pos = 5;
    for (;;) { const kl = b[pos++]; if (kl === 0) break; pos += kl; let vl = b[pos++]; if (vl === 0xfd) { vl = b[pos] | (b[pos + 1] << 8); pos += 2; } pos += vl; }
    return toHex(b.slice(0, pos)) + kvs.join('') + toHex(b.slice(pos));
  };
  const kv = (keyHex, valHex) => { const l = (h) => { const n = h.length / 2; assert.ok(n < 0xfd); return n.toString(16).padStart(2, '0'); }; return l(keyHex) + keyHex + l(valHex) + valHex; };
  // (a PSBT keys each leaf by its control block, so every planted leaf needs its own internal key)
  const leafKV = (scriptHex, internal = NUMS) => kv('15' + 'c0' + internal, scriptHex + 'c0');
  console.log('adversarial');

  // 1. Invented leaves naming fresh attacker keys, each really signed.
  const atk = [0xa1, 0xa2, 0xa3].map(b => new Uint8Array(32).fill(b));
  let forged = proposal;
  const forgedSigs = [];
  for (const sk of atk) {
    const script = '20' + toHex(schnorr.getPublicKey(sk)) + 'ac';
    forged = withInputKVs(forged, [leafKV(script, toHex(schnorr.getPublicKey(sk)))]);
    forgedSigs.push({ sk, script });
  }
  const fp = parsePsbt(forged);
  fp.inputs[0].tapScriptSigs = forgedSigs.map(({ sk, script }) => {
    const leafHash = tapLeafHash(fromHex(script), 0xc0);
    return { pubkey: schnorr.getPublicKey(sk), leafHash, sig: schnorr.sign(tapscriptSighash(fp, 0, leafHash, 0), sk) };
  });
  const inventedSigned = serializePsbt(fp);
  let r = verifySignedPsbt({ psbtHex: inventedSigned, proposalPsbtHex: proposal });
  assert.equal(r.ok, false, 'server counted signatures over invented leaves');
  rejected('adversarial / server: three real signatures over INVENTED leaves count for nothing');
  assert.equal(countSignatures(inventedSigned), 0, 'browser counted signatures over invented leaves');
  rejected('adversarial / browser: the progress count ignores them too');

  // 2. Garbage filed under an honest signer's key must not shut the real one out.
  const real0 = (await signPsbtWithMnemonic(proposal, MNEMONIC, S[0].path, 'testnet')).psbt_hex;
  const realSig = parsePsbt(real0).inputs[0].tapScriptSigs[0];
  const gp = parsePsbt(proposal);
  gp.inputs[0].tapScriptSigs = [{ pubkey: realSig.pubkey, leafHash: realSig.leafHash, sig: new Uint8Array(64).fill(7) }];
  const garbage = serializePsbt(gp);
  assert.equal(verifySignedPsbt({ psbtHex: garbage, proposalPsbtHex: proposal }).ok, false);
  rejected('adversarial / server: garbage filed under a co-signer\'s key');
  const merged = mergePsbts([proposal, garbage, real0]);
  assert.equal(countSignatures(merged), 1, 'the real signature was shut out by garbage');
  assert.deepEqual(verifySignedPsbt({ psbtHex: merged, proposalPsbtHex: proposal }), { ok: true, validSignatures: 1 });
  console.log('  [ok] adversarial / merge: garbage submitted FIRST no longer blocks the real signature');
  const two = mergePsbts([merged, (await signPsbtWithMnemonic(proposal, MNEMONIC, S[1].path, 'testnet')).psbt_hex]);
  const fin = await post('/psbt-finalize', { psbt_hex: two });
  assert.ok(fin.raw_tx_hex, 'a merge that saw garbage must still finalize');
  console.log('  [ok] adversarial / the poisoned proposal still finalizes with two real signatures');

  // 3. A leaf that names OUR key but is not part of the coin: the signer refuses.
  const s0x = S[0].pubkey.slice(2);
  const planted = withInputKVs(proposal, [leafKV('20' + s0x + 'ac')]);
  await assert.rejects(signPsbtWithMnemonic(planted, MNEMONIC, S[0].path, 'testnet'), /not part of the coin/);
  rejected('adversarial / signer: a planted leaf naming our key is refused before signing');
  // ... and our key bytes hidden inside a longer data push are not "our key".
  const hidden = withInputKVs(proposal, [leafKV('21' + s0x + '0075' + '20' + toHex(schnorr.getPublicKey(atk[0])) + 'ac')]);
  const hs = parsePsbt((await signPsbtWithMnemonic(hidden, MNEMONIC, S[0].path, 'testnet')).psbt_hex).inputs[0].tapScriptSigs;
  assert.equal(hs.length, 1, 'signed a leaf that only contains our key bytes as data');
  console.log('  [ok] adversarial / signer: key bytes inside a data push do not make a leaf ours');

  // 4. No stored transaction, a 65-byte signature with a zero type byte, and parser strictness.
  assert.equal(verifySignedPsbt({ psbtHex: real0, proposalPsbtHex: null }).ok, false);
  const zp = parsePsbt(proposal);
  zp.inputs[0].tapScriptSigs = [{ ...realSig, sig: new Uint8Array([...realSig.sig, 0x00]) }];
  assert.equal(verifySignedPsbt({ psbtHex: serializePsbt(zp), proposalPsbtHex: proposal }).ok, false);
  rejected('adversarial / server: no stored transaction, and a 65-byte signature ending 0x00');
  assert.throws(() => parsePsbt(proposal + '00'), /trailing bytes/);
  assert.throws(() => parsePsbt(proposal.slice(0, 40) + 'zz' + proposal.slice(42)), /not valid hex/);
  const dupUtxo = withInputKVs(proposal, [kv('01', '40420f0000000000' + '22' + '5120' + 'ab'.repeat(32))]);
  assert.throws(() => parsePsbt(dupUtxo), /duplicate key/);
  rejected('adversarial / parser: trailing bytes, non-hex text and a duplicate witness-utxo');
}

// ── Compiler review 2026-11-10: vaults weaker than they look must not compile ─
// Each request below was ACCEPTED by the compiler before the fix and produced a
// vault whose real rules were not the ones on the screen.
{
  const twin = (pk) => (pk.startsWith('02') ? '03' : '02') + pk.slice(2); // same x-only key, other parity
  const refuse = async (label, ep, body, needle) => {
    let msg = null;
    try { await post(ep, body); } catch (e) { msg = e.message; }
    assert.ok(msg, `${label}: the compiler ACCEPTED it`);
    assert.ok(msg.includes(needle), `${label}: refused for the wrong reason: ${msg}`);
    rejected(label);
  };
  const named = (o) => ({ founder_keys: keys(0,1), founder_quorum: 2, heir_keys: [], heir_quorum: 1, recovery_after: 0, inheritance_after: 0, address_type: 'tr_multileaf', network: NET, ...o });
  const leaf = (o) => ({ label: o.id, decay: null, ...o });
  const leaves = (extra) => ({ network: NET, leaves: [
    leaf({ id: 'main', keys: keys(0,1), quorum: 2, unlock: { type: 'immediate' } }),
    leaf({ id: 'heirs', keys: keys(3), quorum: 1, unlock: { type: 'after', blocks: 1_200_000 } }),
    ...extra ] });
  const bloc = (o) => ({ network: NET, parent_keys: keys(0,1), parents_together_quorum: 2, coparent_quorum: 1, kid_keys: keys(2,3,4), kids_with_parent_quorum: 3,
    parent_solo_after: 900_000, parent_solo_quorum: 1, kids_decay_start_after: 950_000, kids_decay_step_blocks: 52_560, kids_decay_start_quorum: 3, kids_decay_floor_quorum: 1, ...o });
  console.log('compiler review');

  // One key and its twin: a "2-of-2" that one signature opens.
  const TWIN = 'same Taproot key';
  await refuse('compiler / founders are one key and its twin (a 2-of-2 one signature opens)', '/compile', named({ founder_keys: [S[0].pubkey, twin(S[0].pubkey)] }), TWIN);
  await refuse('compiler / heirs are one key and its twin', '/compile', named({ heir_keys: [S[3].pubkey, twin(S[3].pubkey)], heir_quorum: 2, inheritance_after: 950_000 }), TWIN);
  await refuse('compiler / the consent key is a founder\'s twin (the consent gate would be void)', '/compile', named({ consent_keys: [twin(S[0].pubkey)], consent_quorum: 1 }), TWIN);
  await refuse('compiler / a custom leaf with a twin pair', '/compile-leaves', leaves([leaf({ id: 'x', keys: [S[5].pubkey, twin(S[5].pubkey)], quorum: 2, unlock: { type: 'after', blocks: 1_300_000 } })]), TWIN);
  await refuse('compiler / a kid key is a parent\'s twin', '/compile-bloc', bloc({ kid_keys: [twin(S[0].pubkey), S[3].pubkey, S[4].pubkey] }), TWIN);
  await refuse('compiler / tranche trustees are a twin pair', '/compile-tranche', { network: NET, beneficiary_key: S[5].pubkey, trustee_keys: [S[0].pubkey, twin(S[0].pubkey)], trustee_quorum: 2, unlock_block: 900_000 }, TWIN);
  // ... while the same person in two DIFFERENT paths is still allowed.
  await post('/compile', named({ heir_keys: [S[0].pubkey, S[3].pubkey], heir_quorum: 2, inheritance_after: 950_000 }));
  console.log('  [ok] compiler / a founder who is also an heir (different paths) still compiles');

  // A decay ladder whose lower rungs wrap BIP 68 and open at once.
  const relax = (decay, blocks = 60_000) => leaves([leaf({ id: 'relax', keys: keys(5,6,7), quorum: 3, unlock: { type: 'older', blocks }, decay })]);
  await refuse('compiler / decay rung older(65536) = 0 blocks (a 2-of-3 open at funding)', '/compile-leaves', relax({ step_blocks: 5_536, floor_quorum: 1 }), 'exceeds the');
  await refuse('compiler / decay rung that sets the BIP 68 time flag', '/compile-leaves', relax({ step_blocks: 4_134_304, floor_quorum: 2 }), 'exceeds the');
  await refuse('compiler / decay with a zero step (every rung at once)', '/compile-leaves', relax({ step_blocks: 0, floor_quorum: 1 }, 30_000), 'step_blocks');
  const honest = await post('/compile-leaves', relax({ step_blocks: 10_000, floor_quorum: 1 }, 30_000));
  for (const want of ['older(30000)', 'older(40000)', 'older(50000)']) assert.ok(honest.descriptor.includes(want) || honest.miniscript_policy.includes(want), `honest ladder lost ${want}`);
  console.log('  [ok] compiler / an honest ladder inside the cap still compiles (30000 / 40000 / 50000)');

  // A "height" that Bitcoin reads as a date in the past.
  const DATE = 'not a block height';
  await refuse('compiler / recovery at height 500,000,001 (really a 1985 date: already open)', '/compile', named({ recovery_quorum: 1, heir_keys: keys(3), recovery_after: 500_000_001, inheritance_after: 600_000_000 }), DATE);
  await refuse('compiler / a custom leaf after(1700000000)', '/compile-leaves', leaves([leaf({ id: 'x', keys: keys(5), quorum: 1, unlock: { type: 'after', blocks: 1_700_000_000 } })]), DATE);
  await refuse('compiler / a tranche unlocking at 500,000,000', '/compile-tranche', { network: NET, beneficiary_key: S[5].pubkey, trustee_keys: keys(0,1), trustee_quorum: 2, unlock_block: 500_000_000 }, DATE);
  await refuse('compiler / a kids ladder whose last rung crosses into dates', '/compile-bloc', bloc({ kids_decay_start_after: 499_999_999, kids_decay_step_blocks: 10_000 }), DATE);
}

// ── One key on several paths (2026-11-11) ───────────────────────────────────
// The builder now lets one key (say, a hardware wallet) be picked on more than
// one path. Five paths, signer 0 on three of them: it must compile to one
// address, and each path must spend with exactly the signatures it names --
// the shared key counting on its own paths and for nothing on the others.
{
  const leaf = (o) => ({ label: o.id, decay: null, ...o });
  const policy = { leaves: [
    leaf({ id: 'everyday', keys: keys(0,1,2), quorum: 3, unlock: { type: 'immediate' } }),
    leaf({ id: 'backup',   keys: keys(0,3),   quorum: 2, unlock: { type: 'after', blocks: 900_000 } }),
    leaf({ id: 'kids',     keys: keys(0,4,5), quorum: 2, unlock: { type: 'after', blocks: 950_000 } }),
    leaf({ id: 'friends',  keys: keys(6,7),   quorum: 2, unlock: { type: 'after', blocks: 1_000_000 } }),
    leaf({ id: 'last',     keys: keys(8),     quorum: 1, unlock: { type: 'after', blocks: 1_100_000 } }),
  ] };
  const spendLeaves = ({ label, path, signers }) => cycle({
    label, compileEp: '/compile-leaves', compileBody: { ...policy, network: NET },
    psbtEp: '/psbt-binary', psbtBody: { ...policy, path }, signers,
  });
  console.log('one key on several paths');
  await ok(spendLeaves, { label: 'shared key / everyday, all three sign (shared key included)', path: 'everyday', signers: who(0,1,2) }, 0);
  await ok(spendLeaves, { label: 'shared key / backup, shared key + one other', path: 'backup', signers: who(0,3) }, 900_000);
  await ok(spendLeaves, { label: 'shared key / kids, shared key + one kid', path: 'kids', signers: who(0,4) }, 950_000);
  await ok(spendLeaves, { label: 'shared key / kids, the two kids WITHOUT the shared key', path: 'kids', signers: who(4,5) }, 950_000);
  await ok(spendLeaves, { label: 'shared key / friends, a path the shared key is not on', path: 'friends', signers: who(6,7) }, 1_000_000);
  await ok(spendLeaves, { label: 'shared key / last key alone', path: 'last', signers: who(8) }, 1_100_000);
  await expectFail(spendLeaves, { label: 'shared key / everyday without the shared key', path: 'everyday', signers: who(1,2) }); rejected('an all-must-sign path does not open without the shared key');
  await expectFail(spendLeaves, { label: 'shared key / backup without the shared key', path: 'backup', signers: who(3) }); rejected('the backup path does not open without the shared key');
  await expectFail(spendLeaves, { label: 'shared key / shared key on a path it is not on', path: 'friends', signers: who(0,6) }); rejected('the shared key counts for nothing on a path it is not on');
}

console.log('\noffline-vault-harness OK -- every door of every shape proven end to end');
console.log('(real Rust compiler + real browser signer + real rust-miniscript finalizer; timelocks baked in, quorum/consent/cohort gates enforced)');
