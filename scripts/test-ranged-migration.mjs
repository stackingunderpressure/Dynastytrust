/**
 * test-ranged-migration.mjs -- the ranged-addresses migration stays ADDITIVE
 * and its rollback never runs by itself. Runs in npm test with no database;
 * the full proof on a real Postgres is scripts/ranged-migration-pg.sh.
 *
 * Operator, 2026-11-19: "Preserving existing v1 vaults and addresses ...
 * never silently changing a vault's descriptor or key paths."
 *
 * Run:  node scripts/test-ranged-migration.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };
const root = new URL('..', import.meta.url);
const NAME = '20261119000000_ranged_addresses.sql';
const mig = readFileSync(new URL(`supabase/migrations/${NAME}`, root), 'utf8');
const down = readFileSync(new URL(`supabase/rollbacks/${NAME.replace('.sql', '_down.sql')}`, root), 'utf8');
// SQL without comments, lower-cased, one line.
const code = (s) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase();
const m = code(mig);

// 1. Never changes an existing row or column of vaults.
for (const re of [/\bupdate\s+vaults\b/, /\bdelete\s+from\s+vaults\b/, /\binsert\s+into\s+vaults\b/, /\btruncate\s+(table\s+)?vaults\b/,
  /alter table vaults (drop|rename|alter) column/, /alter table vaults rename\b/, /\bdrop table\b/]) {
  assert.ok(!re.test(m), `the migration must stay additive: found ${re}`);
}
// Every column it adds to vaults is "if not exists"; version 1 by default.
for (const stmt of m.match(/alter table vaults add column[^;]*/g) ?? []) {
  assert.ok(stmt.includes('if not exists'), `not re-runnable: ${stmt}`);
}
assert.match(m, /add column if not exists descriptor_version smallint not null default 1/);
pass('additive only: no update, delete, insert, drop or rename against vaults; existing vaults become version 1 by default');

// 2. Re-runnable: every create/trigger/policy is guarded.
for (const stmt of m.match(/create (table|function|trigger|policy)[^;(]*/g) ?? []) {
  assert.ok(/create table if not exists|create or replace function|create trigger|create policy/.test(stmt), stmt);
}
for (const t of m.match(/create trigger (\w+)/g) ?? []) assert.ok(m.includes(`drop trigger if exists ${t.split(' ')[2]}`), `${t} not dropped first`);
for (const p of m.match(/create policy "([^"]+)"/g) ?? []) assert.ok(m.includes(`drop policy if exists ${p.slice(14)}`), `${p} not dropped first`);
pass('re-runnable: tables if-not-exists, functions create-or-replace, triggers and policies dropped first');

// 3. The lock and the reservation are in it, and only the server may reserve.
assert.match(m, /create trigger vaults_freeze_compiled before update on vaults/);
assert.match(m, /revoke all on function reserve_vault_address_index\(uuid, smallint\) from public, anon, authenticated/);
assert.match(m, /grant execute on function reserve_vault_address_index\(uuid, smallint\) to service_role/);
pass('compiled-vault lock present; only the server role can reserve an index');

// 4. Order and the rollback's place.
const files = readdirSync(new URL('supabase/migrations/', root)).filter(f => f.endsWith('.sql')).sort();
assert.ok(files.indexOf(NAME) >= 0);
assert.ok(!files.some(f => f.includes('_down')), 'a rollback file must never sit in supabase/migrations/');
assert.ok(existsSync(new URL('supabase/rollbacks/', root)));
const d = code(down);
assert.ok(d.indexOf('refusing rollback') < d.indexOf('drop table'), 'rollback must check before it drops anything');
assert.match(d, /descriptor_version = 2/);
assert.match(d, /exists \(select 1 from vault_addresses\)/);
pass('rollback lives outside migrations/ and refuses while any v2 vault or issued address exists');

console.log(`ranged-migration tests passed (${n} cases)`);
