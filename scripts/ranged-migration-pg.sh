#!/usr/bin/env bash
# ranged-migration-pg.sh -- proves 20261119000000_ranged_addresses.sql on a
# real Postgres before it ever reaches the live database. Run by hand; it
# needs a Postgres 16 you can create databases on (PGHOST/PGPORT/PGUSER) and
# scripts/ranged-migration-stub.sql (a minimal Supabase stand-in).
#
#   PGHOST=/tmp PGPORT=55432 PGUSER=postgres bash scripts/ranged-migration-pg.sh
#
# Every existing migration is replayed first, each in ONE transaction like
# scripts/supabase-migrate.sh, with real vault rows in place BEFORE the new
# file runs. Then: existing rows untouched; applying twice is a no-op; the
# compiled-vault lock; 50 simultaneous reservations; the address guard;
# permissions; an interrupted run; rollback refused and allowed.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NEW=20261119000000_ranged_addresses.sql
DB=ranged_mig_test
P="psql -v ON_ERROR_STOP=1 -q -At"
fails=0; n=0
ok()   { n=$((n+1)); echo "  [ok] $1"; }
bad()  { fails=$((fails+1)); echo "  [FAIL] $1"; }
q()    { $P -d $DB -c "$1" 2>&1; }
must_fail() { # sql, label, expected-error-fragment
  local out; out=$($P -d $DB -c "$1" 2>&1) && { bad "$2 (was allowed)"; return; }
  [[ "$out" == *"$3"* ]] && ok "$2" || bad "$2: $out"
}
must_pass() { local out; out=$($P -d $DB -c "$1" 2>&1) && ok "$2" || bad "$2: $out"; }

fresh() { # replay every migration except the new one
  $P -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
  $P -d $DB -f "$ROOT/scripts/ranged-migration-stub.sql" >/dev/null 2>&1
  for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
    [ "$(basename "$f")" = "$NEW" ] && continue
    $P -d $DB -1 -f "$f" >/dev/null 2>&1 || { echo "replay failed at $(basename "$f")"; exit 2; }
  done
}

VEC="$ROOT/protocol/tests/vectors/ranged.json"
M=$(node -e "const s=require('$VEC').shapes.find(s=>s.name==='family');console.log(s.multipath_descriptor)")
R=$(node -e "const s=require('$VEC').shapes.find(s=>s.name==='family');console.log(s.receive_descriptor)")
C=$(node -e "const s=require('$VEC').shapes.find(s=>s.name==='family');console.log(s.change_descriptor)")
RCK=${R##*#}; CCK=${C##*#}
# Descriptors carry apostrophes (48'/1'); double them for SQL literals.
M=${M//\'/\'\'}; R=${R//\'/\'\'}; C=${C//\'/\'\'}
U=11111111-1111-1111-1111-111111111111
V1=aaaaaaaa-0000-0000-0000-000000000001
DRAFT=aaaaaaaa-0000-0000-0000-000000000002
V2=aaaaaaaa-0000-0000-0000-000000000003

echo "1. existing vaults and addresses are preserved"
fresh
q "insert into auth.users (id) values ('$U')" >/dev/null
q "insert into vaults (id,user_id,name,network,address,descriptor,status,address_type,founder_keys,key_origins) values
   ('$V1','$U','Old','signet','tb1pold','tr(old)#abc','compiled','tr_multileaf','[\"02aa\"]','[]'),
   ('$DRAFT','$U','Draft','signet',null,null,'draft','tr_multileaf','[]','[]')" >/dev/null
before=$(q "select md5(string_agg(to_jsonb(v)::text, '|' order by id)) from vaults v")
$P -d $DB -1 -f "$ROOT/supabase/migrations/$NEW" >/dev/null 2>&1 && ok "migration applies after the other $(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' ') files minus itself" || bad "migration failed"
after=$(q "select md5(string_agg((to_jsonb(v) - 'descriptor_version' - 'descriptor_multipath' - 'descriptor_receive' - 'descriptor_change' - 'ranged_format')::text, '|' order by id)) from vaults v")
[ "$before" = "$after" ] && ok "every existing vault row is byte-for-byte unchanged" || bad "existing rows changed"
[ "$(q "select string_agg(descriptor_version::text, ',' order by id) from vaults")" = "1,1" ] && ok "existing vaults are version 1 (column default, no UPDATE)" || bad "versions"
schema1=$(pg_dump -s -d $DB 2>/dev/null | grep -v "^\\\(un\)\?restrict " | md5sum)
$P -d $DB -1 -f "$ROOT/supabase/migrations/$NEW" >/dev/null 2>&1 && ok "applying it a second time succeeds" || bad "second apply failed"
[ "$schema1" = "$(pg_dump -s -d $DB 2>/dev/null | grep -v "^\\\(un\)\?restrict " | md5sum)" ] && ok "and changes nothing (schema identical)" || bad "second apply changed the schema"

echo "2. the v2 version and its descriptors"
must_fail "insert into vaults (id,user_id,status,descriptor_version) values (gen_random_uuid(),'$U','compiled',2)" "a v2 vault without its descriptors is impossible" "vaults_descriptor_version_shape"
must_fail "insert into vaults (id,user_id,status,descriptor_multipath) values (gen_random_uuid(),'$U','compiled','x')" "a v1 vault with v2 descriptors is impossible" "vaults_descriptor_version_shape"
must_pass "insert into vaults (id,user_id,name,network,address,descriptor,status,address_type,descriptor_version,descriptor_multipath,descriptor_receive,descriptor_change,ranged_format)
   values ('$V2','$U','V2','signet','tb1pv2','tr(v2)#x','compiled','tr_multileaf',2,'$M','$R','$C',1)" "a complete v2 vault is accepted"

echo "3. a compiled vault never changes its descriptor or keys"
must_fail "update vaults set descriptor='tr(other)' where id='$V1'" "descriptor change refused" "never change"
must_fail "update vaults set address='tb1pother' where id='$V1'" "address change refused" "never change"
must_fail "update vaults set founder_keys='[\"03bb\"]' where id='$V1'" "key change refused" "never change"
must_fail "update vaults set descriptor_version=2, descriptor_multipath='$M', descriptor_receive='$R', descriptor_change='$C', ranged_format=1 where id='$V1'" "a v1 vault cannot become v2" "never change"
must_fail "update vaults set descriptor_multipath='$C' where id='$V2'" "a v2 vault's descriptors cannot change" "never change"
must_fail "update vaults set status='draft' where id='$V1'" "a compiled vault cannot go back to draft" "draft"
must_pass "update vaults set name='Renamed', archived=true, duress=true, trust_doc='{\"a\":1}' where id='$V1'" "name, archive, halt and trust document still change"
must_pass "update vaults set key_origins='[{\"pubkey\":\"02aa\",\"fingerprint\":\"00000001\",\"derivation_path\":\"m/0\"}]' where id='$V1'" "empty key paths can be filled once"
must_fail "update vaults set key_origins='[{\"pubkey\":\"02aa\",\"fingerprint\":\"00000002\",\"derivation_path\":\"m/1\"}]' where id='$V1'" "filled key paths are never replaced" "filled once"
must_pass "update vaults set descriptor='tr(d)', address='tb1pd', founder_keys='[\"02cc\"]' where id='$DRAFT'" "a draft still changes freely"
must_pass "update vaults set status='compiled' where id='$DRAFT'" "draft -> compiled still works"

echo "4. reserving indexes"
must_fail "select reserve_vault_address_index('$V1', 0::smallint)" "a v1 vault gets no index" "one fixed address"
must_fail "select reserve_vault_address_index('$V2', 2::smallint)" "only branch 0 or 1" "branch must be"
[ "$(q "select reserve_vault_address_index('$V2', 0::smallint)")" = "0" ] && ok "first receive index is 0" || bad "first index"
[ "$(q "select reserve_vault_address_index('$V2', 1::smallint)")" = "0" ] && ok "change counts on its own (first change index is 0)" || bad "change index"
[ "$(q "select reserve_vault_address_index('$V2', 0::smallint)")" = "1" ] && ok "receive moves on independently (next is 1)" || bad "second receive"
tmp=$(mktemp -d)
for i in $(seq 1 50); do ($P -d $DB -c "select reserve_vault_address_index('$V2', 0::smallint)" > "$tmp/$i" 2>&1 &) ; done
for _ in $(seq 1 100); do [ "$(cat "$tmp"/* 2>/dev/null | grep -c '^[0-9]*$')" -ge 50 ] && break; sleep 0.2; done
got=$(cat "$tmp"/* | grep -c '^[0-9]*$'); uniq=$(cat "$tmp"/* | grep '^[0-9]*$' | sort -n | uniq | wc -l)
range=$(cat "$tmp"/* | grep '^[0-9]*$' | sort -n | sed -n '1p;$p' | tr '\n' '-')
[ "$got" = "50" ] && [ "$uniq" = "50" ] && [ "$range" = "2-51-" ] && ok "50 simultaneous reservations: 50 different indexes, 2 to 51, no gaps" || bad "concurrency: got=$got uniq=$uniq range=$range"
[ "$(q "select next_index from vault_address_branches where vault_id='$V2' and branch=0")" = "52" ] && ok "receive counter is 52; change counter untouched at $(q "select next_index from vault_address_branches where vault_id='$V2' and branch=1")" || bad "counter"
rm -rf "$tmp"

echo "5. issued addresses"
must_pass "insert into vault_addresses (vault_id,branch,idx,address,script_pubkey,descriptor_checksum) values ('$V2',0,0,'tb1p-r0','5120aa','$RCK')" "an address from the stored descriptor is recorded"
must_fail "insert into vault_addresses (vault_id,branch,idx,address,script_pubkey,descriptor_checksum) values ('$V2',0,1,'tb1p-r1','5120bb','$CCK')" "the wrong branch's checksum is refused" "not derived from its stored descriptor"
must_fail "insert into vault_addresses (vault_id,branch,idx,address,script_pubkey,descriptor_checksum) values ('$V2',0,0,'tb1p-dup','5120cc','$RCK')" "the same index twice is refused" "duplicate key"
must_fail "insert into vault_addresses (vault_id,branch,idx,address,script_pubkey,descriptor_checksum) values ('$V2',0,1,'tb1p-r0','5120dd','$RCK')" "the same address twice is refused" "duplicate key"
must_fail "insert into vault_addresses (vault_id,branch,idx,address,script_pubkey,descriptor_checksum) values ('$V2',0,99,'tb1p-r99','5120ee','$RCK')" "an index never reserved is refused" "never reserved"
must_fail "insert into vault_addresses (vault_id,branch,idx,address,script_pubkey,descriptor_checksum) values ('$V1',0,0,'tb1p-v1','5120ff','x')" "a v1 vault issues nothing" "one fixed address"
must_fail "update vault_addresses set address='tb1p-moved' where vault_id='$V2' and idx=0" "an issued address never changes" "never changes"
must_pass "update vault_addresses set label='Donations' where vault_id='$V2' and idx=0" "its label can"

echo "6. permissions"
must_fail "set role authenticated; select reserve_vault_address_index('$V2', 0::smallint)" "a signed-in browser cannot reserve" "permission denied"
must_fail "set role authenticated; insert into vault_addresses (vault_id,branch,idx,address,script_pubkey,descriptor_checksum) values ('$V2',0,2,'tb1p-x','51','$RCK')" "a signed-in browser cannot record an address" "permission denied"
must_pass "set role service_role; select reserve_vault_address_index('$V2', 0::smallint)" "the server role can"

echo "7. rollback"
must_fail "$(cat "$ROOT/supabase/rollbacks/20261119000000_ranged_addresses_down.sql")" "rollback refuses while a v2 vault and issued addresses exist" "refusing rollback"
[ "$(q "select count(*) from vault_addresses")" = "1" ] && ok "and nothing was removed" || bad "rollback removed data"

echo "8. interrupted run and clean rollback"
fresh
cp "$ROOT/supabase/migrations/$NEW" /tmp/ranged-broken.sql; echo "select 1/0;" >> /tmp/ranged-broken.sql
$P -d $DB -1 -f /tmp/ranged-broken.sql >/dev/null 2>&1 && bad "broken run succeeded" || ok "a run that fails at its last line is refused"
[ "$(q "select count(*) from information_schema.columns where table_name='vaults' and column_name='descriptor_version'")" = "0" ] \
  && [ -z "$(q "select to_regclass('public.vault_addresses')")" ] && ok "and leaves nothing behind (no column, no table)" || bad "interrupted run left schema"
$P -d $DB -1 -f "$ROOT/supabase/migrations/$NEW" >/dev/null 2>&1 && ok "the next run applies it whole" || bad "re-run after failure"
$P -d $DB -1 -f "$ROOT/supabase/rollbacks/20261119000000_ranged_addresses_down.sql" >/dev/null 2>&1 && ok "with no v2 vault and no address, rollback runs" || bad "clean rollback failed"
[ "$(q "select count(*) from information_schema.columns where table_name='vaults' and column_name like 'descriptor_%'")" = "0" ] && ok "and removes exactly what it added" || bad "rollback left columns"
$P -d $DB -1 -f "$ROOT/supabase/migrations/$NEW" >/dev/null 2>&1 && ok "and the migration applies again afterwards" || bad "re-apply after rollback"

$P -d postgres -c "drop database if exists $DB" >/dev/null
echo "ranged migration on Postgres: $n passed, $fails failed"
[ "$fails" = 0 ]
