/**
 * test-compiler-inprocess.mjs -- the Fly compiler is retired
 * (docs/retire-fly-build-note.md): netlify/functions/_compiler.js answers
 * in-process from the committed compiler WebAssembly. It must give the SAME
 * status and text as the browser's own loader of that module (which
 * scripts/test-compiler-wasm.mjs holds to every recorded Fly answer), refuse
 * an endpoint Fly never served, and need no COMPILER_URL or secret.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-compiler-inprocess.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

delete process.env.COMPILER_URL; delete process.env.COMPILER_SECRET;
let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const { fetchCompiler, compilerFetch, compilerPost } = await import('../netlify/functions/_compiler.js');
const bc = await import('../apps/web/src/lib/browser-compiler.ts');
bc.useCompilerWasmBytes(new Uint8Array(readFileSync(new URL('../apps/web/src/lib/wasm/dynastytrust_compiler_wasm.wasm', import.meta.url))));

const lines = readFileSync(new URL('./fixtures/compiler-reference.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
for (const rec of lines) {
  const res = await compilerPost(rec.endpoint, rec.body);
  const dev = await bc.compileOnDevice(rec.endpoint, rec.body);
  assert.equal(res.status, dev.status, rec.endpoint);
  assert.equal(await res.text(), dev.body, rec.endpoint);
}
pass(`${lines.length} recorded compiler requests: the server's in-process answer equals the browser module's, status and text`);

const v = await compilerFetch('/validate-address', { method: 'POST', body: JSON.stringify({ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', network: 'signet' }) });
assert.equal(v.status, 200); assert.equal((await v.json()).valid, true);
const bad = await fetchCompiler('https://ignored.invalid', '/psbt-finalize', { psbt_hex: 'zz' });
assert.ok(bad.status >= 400 && (await bad.json()).ok === false);
pass('works with no COMPILER_URL or secret; a bad request is refused the way Fly refused it (an error status, ok:false)');

await assert.rejects(() => compilerPost('/health', {}), /unknown compiler endpoint/);
await assert.rejects(() => compilerPost('/ranged-spend', {}), /unknown compiler endpoint/);
pass('only the endpoints Fly served are reachable through it');

console.log(`compiler-inprocess tests passed (${n} cases)`);
