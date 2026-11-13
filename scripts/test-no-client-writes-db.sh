#!/usr/bin/env bash
# Threat model item A (docs/threat-model-2026-11-13.md), proven against a
# REAL Postgres: every migration in supabase/migrations applied in order on
# a slice of Supabase (its three roles, its default "browser roles may do
# anything, policies decide" grants, auth.uid()), then -- as a signed-in
# browser user holding only the public key -- try to rewrite your own
# finalized vault's descriptor and address, forge a proposal, and write the
# other tables. Every write must be refused; reads and the server role must
# still work.
#
# On demand (needs PostgreSQL 13+):  bash scripts/test-no-client-writes-db.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then echo "[no-client-writes] UNVERIFIED: PostgreSQL not found" >&2; exit 1; fi
DIR="$(mktemp -d)"; PORT=54331
chmod 777 "$DIR"
AS() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$1"; else bash -c "$1"; fi; }
cleanup() { AS "$PGBIN/pg_ctl -D $DIR/data -m immediate stop >/dev/null 2>&1" || true; rm -rf "$DIR"; }
trap cleanup EXIT
AS "$PGBIN/initdb -D $DIR/data -A trust >/dev/null"
AS "$PGBIN/pg_ctl -D $DIR/data -o '-p $PORT -c listen_addresses=127.0.0.1 -k $DIR' -l $DIR/log -w start >/dev/null"
PSQL="psql -h 127.0.0.1 -p $PORT -U postgres -v ON_ERROR_STOP=1 -qAt"

$PSQL <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create schema extensions;
create extension if not exists citext;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create publication supabase_realtime;
grant usage on schema public, auth to anon, authenticated, service_role;
-- Supabase's defaults: browser roles get every table privilege; RLS decides.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
SQL
for f in supabase/migrations/*.sql; do
  $PSQL -f "$f" >/dev/null 2>"$DIR/err" || { echo "[no-client-writes] FAIL applying $(basename "$f")"; cat "$DIR/err"; exit 1; }
done
# Twice: the new migration must be safe to run again.
$PSQL -f supabase/migrations/20261113040000_no_client_writes.sql >/dev/null 2>&1

OWNER=11111111-1111-1111-1111-111111111111
$PSQL <<SQL
insert into auth.users values ('$OWNER', 'dad@example.com');
insert into vaults (id, user_id, name, network, address, descriptor, status)
  values ('22222222-2222-2222-2222-222222222222', '$OWNER', 'Family', 'bitcoin', 'bc1p-real', 'tr(real)', 'compiled');
SQL
as_owner() { $PSQL -c "set role authenticated; set test.uid = '$OWNER'; $1" 2>&1 || true; }
n=0; ok() { n=$((n+1)); echo "  [ok] $1"; }
expect_refused() {
  out=$(as_owner "$2")
  if echo "$out" | grep -qiE "permission denied|violates row-level security"; then ok "$1"; return; fi
  # An UPDATE/DELETE can also be "refused" by matching zero rows; say so honestly.
  if echo "$out" | grep -qE "^(UPDATE|DELETE) 0$"; then ok "$1 (0 rows)"; return; fi
  echo "  [FAIL] $1 -- got: $out"; exit 1
}

expect_refused "owner cannot rewrite their finalized vault's descriptor and address" \
  "update vaults set descriptor = 'tr(attacker)', address = 'bc1p-attacker' where user_id = '$OWNER';"
[ "$($PSQL -c "select address from vaults")" = "bc1p-real" ] && ok "the stored address is unchanged"
expect_refused "owner cannot insert a vault directly" \
  "insert into vaults (user_id, name, network, status) values ('$OWNER', 'x', 'bitcoin', 'draft');"
expect_refused "owner cannot delete a vault directly" "delete from vaults where user_id = '$OWNER';"
expect_refused "nobody can forge a proposal directly" \
  "insert into proposals (vault_id, user_id, path, destination, amount_sats, status) values ('22222222-2222-2222-2222-222222222222', '$OWNER', 'founders_now', 'bc1q-x', 1, 'signed');"
expect_refused "nobody can add themselves as a vault member directly" \
  "insert into vault_members (vault_id, user_id, role, status) values ('22222222-2222-2222-2222-222222222222', '$OWNER', 'founder', 'active');"
expect_refused "nobody can write a saved secret directly" "delete from sent_secrets;"
expect_refused "nobody can write a messaging-key backup directly" \
  "insert into messaging_key_backups (user_id, pubkey, wrapped_priv_b64, salt_b64, nonce_b64) values ('$OWNER','p','w','s','n');"
expect_refused "nobody can bind a sign-in key directly" \
  "insert into wallet_identities (user_id, pubkey) values ('$OWNER', 'aa');"
out=$(as_owner "select address from vaults;")
echo "$out" | grep -q "bc1p-real" && ok "the owner can still READ their vault"
policies=$($PSQL -c "select count(*) from pg_policies where schemaname='public' and cmd <> 'SELECT'")
[ "$policies" = "0" ] && ok "no write policy is left on any table (count $policies)"
$PSQL -c "set role service_role; update vaults set name = 'Family vault';" >/dev/null && ok "the server role still writes"
echo "no-client-writes db tests passed ($n checks)"
