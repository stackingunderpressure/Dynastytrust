/**
 * test-protocol-wasm.mjs -- the in-browser vault-address check.
 *  1. The committed .wasm is the one built from the Rust source in this
 *     repo (manifest fingerprints both); edit protocol-wasm/ without
 *     running scripts/build-protocol-wasm.mjs and this fails.
 *  2. The app's own loader (apps/web/src/lib/descriptor-check.ts) runs
 *     that committed file and gets the BIP 86 test vector right, refuses
 *     garbage, and reports a swapped address as a mismatch.
 * Every real vault shape is checked against the real compiler by the
 * offline harness (scripts/offline-vault-harness.mjs). Wired into npm test.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-protocol-wasm.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sourceSha256 } from './protocol-wasm-source.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(root + 'apps/web/src/lib/wasm/protocol-wasm.manifest.json', 'utf8'));
const wasm = readFileSync(root + 'apps/web/src/lib/wasm/dynastytrust_protocol_wasm.wasm');
let n = 0;
const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

assert.equal(sourceSha256(root), manifest.sourceSha256, 'protocol-wasm/ changed since the .wasm was built: run node scripts/build-protocol-wasm.mjs');
assert.equal(createHash('sha256').update(wasm).digest('hex'), manifest.wasmSha256, 'the committed .wasm is not the one the manifest names');
assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(wasm)), [], 'the module must need nothing from the page');
pass(`committed .wasm matches its Rust source (${manifest.wasmBytes} bytes)`);

const dc = await import('../apps/web/src/lib/descriptor-check.ts');
dc.useProtocolWasmBytes(new Uint8Array(wasm));
const XPUB = 'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ';
const ADDR = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'; // BIP 86 test vector
const desc = `tr([73c5da0a/86'/0'/0']${XPUB}/0/0)`;
assert.deepEqual(await dc.descriptorAddress(desc, 'bitcoin'), { ok: true, address: ADDR });
pass('BIP 86 test vector through the app loader');

assert.equal((await dc.checkVaultAddress({ descriptor: desc, address: ADDR, network: 'bitcoin' })).status, 'match');
assert.equal((await dc.checkVaultAddress({ descriptor: desc, address: ADDR.toUpperCase(), network: 'bitcoin' })).status, 'match', 'bech32 is case-insensitive');
const other = 'bc1p' + 'q'.repeat(58);
assert.deepEqual(await dc.checkVaultAddress({ descriptor: desc, address: other, network: 'bitcoin' }), { status: 'mismatch', stored: other, derived: ADDR });
assert.equal((await dc.checkVaultAddress({ descriptor: desc, address: ADDR, network: 'signet' })).status, 'mismatch', 'a mainnet address shown on a signet vault is a mismatch');
assert.equal((await dc.checkVaultAddress({ descriptor: 'tr(nonsense)', address: ADDR, network: 'bitcoin' })).status, 'unreadable');
// A stale checksum (left by the app's own key-origin rewrite of a wsh
// vault) is ignored -- the address comparison is what decides.
assert.equal((await dc.checkVaultAddress({ descriptor: desc + '#aaaaaaaa', address: ADDR, network: 'bitcoin' })).status, 'match');
assert.equal((await dc.checkVaultAddress({ descriptor: desc + '#aaaaaaaa', address: other, network: 'bitcoin' })).status, 'mismatch');
assert.equal((await dc.checkVaultAddress({ descriptor: null, address: ADDR, network: 'bitcoin' })).status, 'unreadable', 'an address with nothing to check it against is not shown');
assert.equal((await dc.checkVaultAddress({ descriptor: null, address: null, network: 'signet' })).status, 'not_applicable');
pass('match, mismatch, wrong network, garbage, stale checksum, missing descriptor, draft');

// Many calls must not leak memory.
for (let i = 0; i < 2000; i++) assert.equal((await dc.descriptorAddress(desc, 'bitcoin')).ok, true);
pass('2,000 checks in a row, all answered');

console.log(`protocol-wasm tests passed (${n} cases)`);
