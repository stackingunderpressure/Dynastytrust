/**
 * build-compiler-wasm.mjs -- rebuild the in-browser vault COMPILER
 * (compiler-wasm/, which runs protocol/src/service.rs, the same code as the
 * Fly server) and commit its output into the web app (sovereign slice 1,
 * docs/super-sovereign-build-note.md).
 *
 * scripts/test-compiler-wasm.mjs (in npm test) fails if compiler-wasm/ or
 * protocol/ changed since the committed .wasm was built, and replays the
 * recorded compiler answers through it.
 *
 * Run after any change under compiler-wasm/ or protocol/:
 *   node scripts/build-compiler-wasm.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sourceSha256 } from './compiler-wasm-source.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const crate = root + 'compiler-wasm';
execFileSync('cargo', ['build', '--release', '--locked', '--target', 'wasm32-unknown-unknown'], { cwd: crate, stdio: 'inherit' });
const built = crate + '/target/wasm32-unknown-unknown/release/dynastytrust_compiler_wasm.wasm';
const out = root + 'apps/web/src/lib/wasm/dynastytrust_compiler_wasm.wasm';
copyFileSync(built, out);
const wasm = readFileSync(out);
const rustc = execFileSync('rustc', ['--version'], { cwd: crate }).toString().trim();
const manifest = {
  note: 'Written by scripts/build-compiler-wasm.mjs. Do not edit by hand.',
  sourceSha256: sourceSha256(root),
  wasmSha256: createHash('sha256').update(wasm).digest('hex'),
  wasmBytes: wasm.length,
  rustc,
};
writeFileSync(root + 'apps/web/src/lib/wasm/compiler-wasm.manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`built ${wasm.length} bytes, source ${manifest.sourceSha256.slice(0, 12)}, ${rustc}`);
