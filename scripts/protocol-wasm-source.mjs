// The source fingerprint shared by build-protocol-wasm.mjs and its test:
// SHA-256 over every file that decides what the .wasm contains.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
export const SOURCE_FILES = ['protocol-wasm/Cargo.toml', 'protocol-wasm/Cargo.lock', 'protocol-wasm/src/lib.rs'];
export function sourceSha256(root) {
  const h = createHash('sha256');
  for (const f of SOURCE_FILES) { h.update(f + '\0'); h.update(readFileSync(root + f)); h.update('\0'); }
  return h.digest('hex');
}
