/**
 * test-vault-pin.mjs -- threat model item B (docs/threat-model-2026-11-13.md):
 * each phone pins the vault it agreed to, and checks that the key it joined
 * with is really in it. Uses the app's own gate checks (lib/vault-gate.ts)
 * with the REAL committed in-browser compiler module. Every real vault shape
 * is also checked by the offline harness. Wired into npm test.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-vault-pin.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const dc = await import('../apps/web/src/lib/descriptor-check.ts');
dc.useProtocolWasmBytes(new Uint8Array(readFileSync(new URL('../apps/web/src/lib/wasm/dynastytrust_protocol_wasm.wasm', import.meta.url))));
const { runGateChecks } = await import('../apps/web/src/lib/vault-gate.ts');
const pin = await import('../apps/web/src/lib/vault-pin.ts');
const { HDKey } = await import('@scure/bip32');
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const hex = (b) => Buffer.from(b).toString('hex');

// Two real, different, self-consistent vaults (BIP 86 test vector and a second key).
const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(9));
const acctA = root.derive("m/86'/0'/0'"), acctB = root.derive("m/86'/0'/1'");
const descA = `tr([${hex(root.identifier.slice(0, 4))}/86'/0'/0']${acctA.publicExtendedKey}/0/0)`;
const descB = `tr([${hex(root.identifier.slice(0, 4))}/86'/0'/1']${acctB.publicExtendedKey}/0/0)`;
const addrA = (await dc.descriptorAddress(descA, 'bitcoin')).address, addrB = (await dc.descriptorAddress(descB, 'bitcoin')).address;
const myKeyA = hex(acctA.deriveChild(0).deriveChild(0).publicKey);
const none = async () => null;

// 1. First open pins; the next open matches.
let r = await runGateChecks({ id: 'v1', descriptor: descA, address: addrA, network: 'bitcoin' }, none);
assert.equal(r.status, 'match');
assert.equal(JSON.parse(store.get('dt:vaultPins:v1')).v1.address, addrA.toLowerCase());
r = await runGateChecks({ id: 'v1', descriptor: descA, address: addrA, network: 'bitcoin' }, none);
assert.equal(r.status, 'match');
pass('a finalized vault is pinned on first open and matches after');

// 2. A self-consistent swap (another real vault's descriptor + address) passes the
//    address check but is stopped by the pin.
assert.equal((await dc.checkVaultAddress({ descriptor: descB, address: addrB, network: 'bitcoin' })).status, 'match', 'the address check alone cannot see this swap');
r = await runGateChecks({ id: 'v1', descriptor: descB, address: addrB, network: 'bitcoin' }, none);
assert.equal(r.status, 'pin_changed');
assert.equal(r.pinned, addrA.toLowerCase()); assert.equal(r.now, addrB.toLowerCase());
pass('a self-consistent swap is stopped by the phone\'s pin');

// 3. The descriptor text may change (hardware-wallet key details repaired) while
//    the address stays: not stopped.
const repaired = descA.replace(/\[[0-9a-f]{8}\//, '[00000000/');
assert.equal((await dc.descriptorAddress(repaired, 'bitcoin')).address, addrA);
r = await runGateChecks({ id: 'v1', descriptor: repaired, address: addrA, network: 'bitcoin' }, none);
assert.equal(r.status, 'match');
pass('a repaired key-detail rewrite with the same address is not stopped');

// 4. Own key: present passes; absent stops; a lookup failure does not block.
r = await runGateChecks({ id: 'v2', descriptor: descA, address: addrA, network: 'bitcoin' }, async () => myKeyA);
assert.equal(r.status, 'match');
r = await runGateChecks({ id: 'v3', descriptor: descB, address: addrB, network: 'bitcoin' }, async () => myKeyA);
assert.deepEqual(r, { status: 'own_key_missing', pubkey: myKeyA });
r = await runGateChecks({ id: 'v4', descriptor: descA, address: addrA, network: 'bitcoin' }, async () => { throw new Error('offline'); });
assert.equal(r.status, 'match');
assert.equal(pin.ownKeyInDescriptor(`tr(${myKeyA.slice(2)})`, myKeyA), true, 'an x-only key in the script counts');
pass('the key this phone joined with must be in the vault; a lookup failure does not block');

// 5. Drafts are never pinned.
r = await runGateChecks({ id: 'v5', descriptor: null, address: null, network: 'signet' }, none);
assert.equal(r.status, 'not_applicable');
assert.equal(JSON.parse(store.get('dt:vaultPins:v1')).v5, undefined);
pass('a draft is never pinned');

console.log(`vault-pin tests passed (${n} cases)`);
