/**
 * build-protocol-wasm.mjs -- rebuild the in-browser vault-address check
 * (protocol-wasm/) and commit its output into the web app.
 *
 * Netlify's build has no Rust, so the .wasm is committed, the same way
 * the offline legacy-recovery tool is. Next to it goes a manifest naming
 * the SHA-256 of the exact source it was built from;
 * scripts/test-protocol-wasm.mjs (in npm test) fails if the source has
 * changed since, or if the committed .wasm is not the one the manifest
 * names. So the file the browser runs can never drift silently from the
 * Rust in this repo.
 *
 * Run after any change under protocol-wasm/:
 *   node scripts/build-protocol-wasm.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sourceSha256 } from './protocol-wasm-source.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const crate = root + 'protocol-wasm';
execFileSync('cargo', ['build', '--release', '--locked', '--target', 'wasm32-unknown-unknown'], { cwd: crate, stdio: 'inherit' });
const built = crate + '/target/wasm32-unknown-unknown/release/dynastytrust_protocol_wasm.wasm';
const out = root + 'apps/web/src/lib/wasm/dynastytrust_protocol_wasm.wasm';
copyFileSync(built, out);
const wasm = readFileSync(out);
const rustc = execFileSync('rustc', ['--version'], { cwd: crate }).toString().trim();
const manifest = {
  note: 'Written by scripts/build-protocol-wasm.mjs. Do not edit by hand.',
  sourceSha256: sourceSha256(root),
  wasmSha256: createHash('sha256').update(wasm).digest('hex'),
  wasmBytes: wasm.length,
  rustc,
};
writeFileSync(root + 'apps/web/src/lib/wasm/protocol-wasm.manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`built ${wasm.length} bytes, source ${manifest.sourceSha256.slice(0, 12)}, ${rustc}`);
