/**
 * test-compiler-wasm.mjs -- the vault compiler in the browser (sovereign
 * slice 1, docs/super-sovereign-build-note.md).
 *  1. The committed .wasm is the one built from compiler-wasm/ and the
 *     shared library protocol/ (manifest fingerprints both); edit either
 *     without running scripts/build-compiler-wasm.mjs and this fails.
 *  2. It needs nothing from the page (no imports).
 *  3. Through the app's own loader (apps/web/src/lib/browser-compiler.ts),
 *     it gives every recorded answer of the server
 *     (scripts/fixtures/compiler-reference.jsonl: 231 requests, every
 *     endpoint, refusals included) -- see scripts/compiler-parity.mjs for
 *     the exact bar. Wired into npm test.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-compiler-wasm.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceSha256 } from './compiler-wasm-source.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(root + 'apps/web/src/lib/wasm/compiler-wasm.manifest.json', 'utf8'));
const wasm = readFileSync(root + 'apps/web/src/lib/wasm/dynastytrust_compiler_wasm.wasm');
let n = 0;
const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

assert.equal(sourceSha256(root), manifest.sourceSha256, 'compiler-wasm/ or protocol/ changed since the .wasm was built: run node scripts/build-compiler-wasm.mjs');
assert.equal(createHash('sha256').update(wasm).digest('hex'), manifest.wasmSha256, 'the committed .wasm is not the one the manifest names');
assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(wasm)), [], 'the module must need nothing from the page');
pass(`committed .wasm matches its Rust source (${manifest.wasmBytes} bytes, no imports)`);

const out = execFileSync(process.execPath, [
  '--experimental-strip-types', '--import', './scripts/register-ts-resolver.mjs',
  'scripts/compiler-parity.mjs', 'scripts/fixtures/compiler-reference.jsonl', '--target', 'wasm',
], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const m = out.match(/compiler parity \(wasm\): (\d+)\/(\d+) identical/);
assert.ok(m && m[1] === m[2] && Number(m[2]) >= 231, `browser compiler differs from the server:\n${out}`);
pass(`every recorded server answer reproduced in the browser module (${m[1]}/${m[2]})`);

console.log(`compiler-wasm tests passed (${n} cases)`);
