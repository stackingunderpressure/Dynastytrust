#!/usr/bin/env bash
# test-zk-db.sh -- zero-knowledge storage Z1 slice 1 against a REAL Postgres:
# replays EVERY migration on a throwaway cluster (with a small stand-in for
# Supabase's auth schema and roles), re-applies the new migration to prove it
# is idempotent, checks its constraints and the browser-role write ban, then
# runs scripts/reset-test-data.sql and checks it empties every vault table,
# keeps accounts, and leaves the ledger's append-only triggers enabled.
#
# On demand (needs PostgreSQL 13+ server binaries; run as root or postgres):
#   bash scripts/test-zk-db.sh
set -eu  # no pipefail: the refusal checks expect psql to fail
W="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then
  echo "[zk-db] UNVERIFIED: PostgreSQL server binaries not found" >&2; exit 1
fi
DIR=$(mktemp -d); chmod 777 "$DIR"; PORT=54331
AS() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$1"; else bash -c "$1"; fi; }
cleanup() { AS "$PGBIN/pg_ctl -D $DIR/data -m immediate stop >/dev/null 2>&1" || true; rm -rf "$DIR"; }
trap cleanup EXIT
AS "$PGBIN/initdb -D $DIR/data -A trust >/dev/null"
AS "$PGBIN/pg_ctl -D $DIR/data -o '-p $PORT -c listen_addresses=127.0.0.1 -k $DIR' -l $DIR/log -w start >/dev/null"
PSQL="psql -h 127.0.0.1 -p $PORT -U postgres -v ON_ERROR_STOP=1 -qAt -d postgres"
$PSQL >/dev/null <<'STUB'
-- Minimal Supabase stand-in for replaying supabase/migrations locally.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(current_setting('request.jwt.claim.role', true), 'anon') $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create schema extensions; create schema storage;
grant usage on schema public to anon, authenticated, service_role;
create extension if not exists citext;
create extension if not exists pgcrypto;
create publication supabase_realtime;
alter table auth.users add column if not exists raw_app_meta_data jsonb default '{}'::jsonb;
alter table auth.users add column if not exists phone text;
alter table auth.users add column if not exists email_confirmed_at timestamptz;
alter table auth.users add column if not exists last_sign_in_at timestamptz;
STUB
for f in $(ls $W/supabase/migrations/*.sql | sort); do
  $PSQL -f "$f" >/dev/null 2>$DIR/err || { echo "FAILED: $(basename $f)"; cat $DIR/err; exit 1; }
done
echo "all $(ls $W/supabase/migrations/*.sql | wc -l) migrations applied"
# apply the new one twice: must be idempotent
$PSQL -f $W/supabase/migrations/20261124000000_zk_vault_keys.sql >/dev/null && echo "zk migration re-applied cleanly"
$PSQL <<'SQL'
insert into auth.users(id) values ('00000000-0000-0000-0000-00000000000a'),('00000000-0000-0000-0000-00000000000b');
insert into vaults(id, user_id, name, network) values ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-00000000000a','Test vault','signet');
select 'defaults', vault_key_version, vault_key_checks from vaults;
insert into vault_keys(vault_id, version, recipient_user_id, recipient_pubkey, created_by, wrap)
  values ('00000000-0000-0000-0000-0000000000f1',1,'00000000-0000-0000-0000-00000000000b','aa','00000000-0000-0000-0000-00000000000a','{}');
SQL
# duplicate wrap ignored by unique; different pubkey allowed
$PSQL -c "insert into vault_keys(vault_id, version, recipient_user_id, recipient_pubkey, created_by, wrap) values ('00000000-0000-0000-0000-0000000000f1',1,'00000000-0000-0000-0000-00000000000b','aa','00000000-0000-0000-0000-00000000000a','{}')" 2>&1 | tail -1 | sed "s/^/DUP: /"
$PSQL -c "insert into vault_keys(vault_id, version, recipient_user_id, recipient_pubkey, created_by, wrap) values ('00000000-0000-0000-0000-0000000000f1',1,'00000000-0000-0000-0000-00000000000b','bb','00000000-0000-0000-0000-00000000000a','{}')" && echo "new-device wrap accepted"
$PSQL -c "insert into vault_keys(vault_id, version, recipient_user_id, recipient_pubkey, created_by, wrap) values ('00000000-0000-0000-0000-0000000000f1',0,'00000000-0000-0000-0000-00000000000b','cc','00000000-0000-0000-0000-00000000000a','{}')" 2>&1 | tail -1 | sed "s/^/V0: /"
# browser roles cannot write
$PSQL -c "set role authenticated; insert into vault_keys(vault_id, version, recipient_user_id, recipient_pubkey, created_by, wrap) values ('00000000-0000-0000-0000-0000000000f1',2,'00000000-0000-0000-0000-00000000000b','dd','00000000-0000-0000-0000-00000000000b','{}')" 2>&1 | tail -1 | sed "s/^/ROLE: /"
# comments: sealed-only row allowed, empty row refused
$PSQL <<'SQL'
insert into proposals(id, vault_id, user_id, path, destination, amount_sats, status) values ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-00000000000a','founders_now','tb1qtest',1000,'pending');
insert into proposal_comments(proposal_id, user_id, sealed) values ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-00000000000a','zk1:1:abc');
SQL
echo "sealed-only comment accepted"
$PSQL -c "insert into proposal_comments(proposal_id, user_id) values ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-00000000000a')" 2>&1 | tail -1 | sed "s/^/EMPTY: /"
# a ledger entry, then the reset
$PSQL -c "insert into vault_ledger(vault_id, seq, recorded_at, actor_user_id, event_type, payload, payload_canon, prev_hash, entry_hash) values ('00000000-0000-0000-0000-0000000000f1', 1, now()::text, '00000000-0000-0000-0000-00000000000a', 'test', '{}'::jsonb, '{}', repeat('0',64), repeat('a',64))" 2>&1 | tail -1 | sed "s/^/LEDGERINS: /"
$PSQL -c "select count(*) from vault_ledger" | sed "s/^/LEDGERCOUNT: /"
$PSQL -c "delete from vault_ledger" 2>&1 | tail -1 | sed "s/^/LEDGERDEL: /"
$PSQL < $W/scripts/reset-test-data.sql
$PSQL -c "select 'remaining', (select count(*) from vaults),(select count(*) from vault_keys),(select count(*) from proposal_comments),(select count(*) from vault_ledger),(select count(*) from auth.users)"
$PSQL -c "delete from vault_ledger" 2>&1 | tail -1 | sed "s/^/LEDGERDEL-AFTER: /"
$PSQL -c "select tgname, tgenabled from pg_trigger where tgname like 'vault_ledger%no_%' order by tgname" | sed "s/^/TRIG: /"
