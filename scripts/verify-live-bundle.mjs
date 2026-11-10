/**
 * verify-live-bundle.mjs -- is the code dynastytrust.family is serving
 * RIGHT NOW the code in this repository, and nothing else?
 *
 * The browser bundle holds everyone's keys in its hands. If the host,
 * the build service, or a stolen deploy credential ever served a
 * different bundle than the one this source produces, nothing inside
 * the app could tell. This check can: it reads which commit the live
 * site says it is, builds that exact commit from scratch in a throwaway
 * checkout with the same command Netlify runs (`npm ci`, lockfile
 * only), and compares every file byte for byte.
 *
 * The three public build settings (Supabase URL, anon key, Tapit wallet
 * URL) are read out of the live bundle itself -- they are public values
 * baked into the page, not secrets -- so the comparison needs no access
 * to Netlify. Everything else in the bundle must come from the source.
 *
 * First proven 2026-11-10 against commit d9e7548: index.html, the JS
 * bundle and the CSS all byte-identical (built under Node 22 while
 * Netlify used Node 20 -- the build is reproducible across both).
 *
 * On demand, not part of `npm test` (it reinstalls and rebuilds, ~2 min):
 *   node scripts/verify-live-bundle.mjs [https://dynastytrust.family]
 * Exit 0 = identical. Exit 1 = DIFFERENT or could not be checked.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = (process.argv[2] || 'https://dynastytrust.family').replace(/\/$/, '');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const die = (msg) => { console.error(`[verify-live] ${msg}`); process.exit(1); };
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

async function get(path) {
  const res = await fetch(`${site}${path}${path.includes('?') ? '&' : '?'}cb=${Date.now()}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

let live;
try {
  live = JSON.parse((await get('/version.json')).toString('utf8'));
} catch (e) {
  die(`UNVERIFIED: could not read ${site}/version.json (${e.message})`);
}
let commit;
try {
  commit = git('rev-parse', '--verify', `${live.version}^{commit}`);
} catch {
  die(`UNVERIFIED: the live site says it is commit ${live.version}, which is not in this repository. Fetch first (git fetch origin main); if it is still unknown, the site is serving a build of code you do not have.`);
}
console.log(`[verify-live] ${site} says it is ${live.version} (built ${live.builtAt}); rebuilding ${commit.slice(0, 12)} from source...`);

const indexHtml = await get('/');
const entry = indexHtml.toString('utf8').match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
if (!entry) die('UNVERIFIED: could not find the JS bundle in the live index.html');
const liveJs = (await get(entry)).toString('utf8');
const env = {
  VITE_SUPABASE_URL: liveJs.match(/"(https:\/\/[a-z0-9]+\.supabase\.co\/?)"/)?.[1],
  VITE_SUPABASE_ANON_KEY: liveJs.match(/"(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/)?.[1],
  VITE_TAPIT_WALLET_URL: liveJs.match(/="\/api",[A-Za-z0-9_$]+="(https:\/\/[^"]+)"/)?.[1],
};
for (const [k, v] of Object.entries(env)) {
  if (!v) die(`UNVERIFIED: could not read the public setting ${k} out of the live bundle`);
}
console.log(`[verify-live] public settings read from the live page: ${env.VITE_SUPABASE_URL}, anon key (${env.VITE_SUPABASE_ANON_KEY.length} chars), ${env.VITE_TAPIT_WALLET_URL}`);

const work = mkdtempSync(join(tmpdir(), 'dt-verify-'));
let failed = [];
try {
  git('worktree', 'add', '--detach', work, commit);
  const toml = readFileSync(join(work, 'netlify.toml'), 'utf8');
  const command = toml.match(/^\s*command = "(.*)"\s*$/m)?.[1];
  if (!command) die('UNVERIFIED: no build command in that commit\'s netlify.toml');
  const r = spawnSync('bash', ['-c', command], {
    cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env, COMMIT_REF: commit, CI: 'true' },
  });
  if (r.status !== 0) die(`UNVERIFIED: the source build failed:\n${(r.stdout + r.stderr).slice(-1500)}`);

  const dist = join(work, 'apps', 'web', 'dist');
  const files = ['index.html', ...readdirSync(join(dist, 'assets')).map(f => `assets/${f}`)];
  for (const f of files) {
    const local = readFileSync(join(dist, f));
    let remote;
    try { remote = f === 'index.html' ? indexHtml : await get(`/${f}`); } catch { remote = null; }
    const same = remote && sha256(remote) === sha256(local);
    console.log(`  ${same ? 'same     ' : 'DIFFERENT'}  ${f}  ${sha256(local).slice(0, 16)}${remote ? '' : '  (not served by the live site)'}`);
    if (!same) failed.push(f);
  }
} finally {
  try { git('worktree', 'remove', '--force', work); } catch { /* fall through to rm */ }
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
}

if (failed.length) {
  die(`FAIL: ${failed.length} file(s) served by ${site} are NOT what commit ${commit.slice(0, 12)} builds: ${failed.join(', ')}. Do not sign with this site until this is explained.`);
}
console.log(`[verify-live] PASS: every file ${site} serves is byte-identical to a clean build of commit ${commit.slice(0, 12)}`);
