/**
 * test-wasm-bundling.mjs -- every Netlify function that reaches the compiler
 * WebAssembly (through _ranged-wasm.js, directly or via a helper) must list
 * the .wasm and its manifest in netlify.toml `included_files`. Esbuild does
 * not bundle a file read from disk; a function without it refuses at run
 * time. Found 2026-11-24: five functions shipped without it.
 *
 * Run:  node scripts/test-wasm-bundling.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../netlify/functions/', import.meta.url);
const src = (f) => readFileSync(new URL(f, dir), 'utf8');
const files = readdirSync(dir).filter(f => f.endsWith('.js'));
const imports = (f) => [...src(f).matchAll(/from\s+["']\.\/([^"']+)["']/g)].map(m => m[1]);
const reaches = new Map();
const reachesWasm = (f, seen = new Set()) => {
  if (f === '_ranged-wasm.js') return true;
  if (seen.has(f)) return false;
  seen.add(f);
  return imports(f).some(i => files.includes(i) && reachesWasm(i, seen));
};
const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
const listed = (name) => {
  const m = toml.match(new RegExp(`\\[functions\\."${name}"\\]([\\s\\S]*?)(?=\\n\\[|$)`));
  return !!m && m[1].includes('dynastytrust_compiler_wasm.wasm') && m[1].includes('compiler-wasm.manifest.json');
};
const handlers = files.filter(f => !f.startsWith('_'));
const need = handlers.filter(f => reachesWasm(f)).map(f => f.replace(/\.js$/, ''));
assert.ok(need.length >= 6, `expected the fresh-address functions, found ${need}`);
const missing = need.filter(n => !listed(n));
assert.deepEqual(missing, [], `these functions run the compiler WebAssembly but do not ship it: ${missing.join(', ')}`);
console.log(`wasm-bundling tests passed (${need.length} functions ship the compiler WebAssembly: ${need.join(', ')})`);
