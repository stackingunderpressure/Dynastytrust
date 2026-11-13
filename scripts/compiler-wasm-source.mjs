// The source fingerprint shared by build-compiler-wasm.mjs and its test:
// SHA-256 over every file that decides what the browser compiler contains --
// its own crate AND the shared library it runs (protocol/), which the Fly
// server runs too (sovereign slice 1).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
export function sourceFiles(root) {
  const lib = readdirSync(root + 'protocol/src').filter(f => f.endsWith('.rs')).sort().map(f => 'protocol/src/' + f);
  return ['compiler-wasm/Cargo.toml', 'compiler-wasm/Cargo.lock', 'compiler-wasm/src/lib.rs', 'protocol/Cargo.toml', ...lib];
}
export function sourceSha256(root) {
  const h = createHash('sha256');
  for (const f of sourceFiles(root)) { h.update(f + '\0'); h.update(readFileSync(root + f)); h.update('\0'); }
  return h.digest('hex');
}
