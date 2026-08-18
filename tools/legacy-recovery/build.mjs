// Bundles recover.ts (which imports the real, tested legacy-recovery.ts
// crypto functions) into a single IIFE with esbuild, then inlines it into
// template.html to produce ONE self-contained, offline-capable HTML file.
// Writes directly into apps/web/public/ so Vite serves it at a stable URL
// and it's committed to the repo like any other static asset -- this is
// a BUILD ARTIFACT, not generated at deploy time, so re-run this script
// and commit the result whenever legacy-recovery.ts changes.
// Run: node tools/legacy-recovery/build.mjs
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [join(here, 'recover.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  logLevel: 'info',
});

const script = result.outputFiles[0].text;
const template = readFileSync(join(here, 'template.html'), 'utf8');
const out = template.replace('__SCRIPT__', script);

const outDir = join(here, '..', '..', 'apps', 'web', 'public');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'dynastytrust-legacy-recovery-tool.html');
writeFileSync(outPath, out, 'utf8');
console.log(`Wrote ${outPath} (${(out.length / 1024).toFixed(1)} KB)`);
