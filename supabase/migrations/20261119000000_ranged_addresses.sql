-- ============================================================
-- Ranged (v2) vault addresses: the database half (slice 2).
-- Plan: docs/ranged-addresses-slice2-build-note.md (operator's OK,
-- 2026-11-19: key paths fill-once, Rust derivation in the function,
-- counters in their own table, no v2 creation yet).
--
-- ADDITIVE ONLY. This file never updates, deletes, renames or drops an
-- existing row or column. Every existing vault becomes
-- descriptor_version = 1 through the column default, not by an UPDATE
-- (scripts/test-ranged-migration.mjs fails if a data-changing statement
-- against vaults ever appears here). Safe to re-run: every statement is
-- if-not-exists / create-or-replace / drop-if-exists.
--
-- Rollback: supabase/rollbacks/20261119000000_ranged_addresses_down.sql
-- (outside migrations/, never runs by itself; refuses once any v2 vault
-- or issued address exists).
-- ============================================================

-- 1. The derivation version, and the v2 descriptors -------------------

alter table vaults add column if not exists descriptor_version smallint not null default 1;
alter table vaults add column if not exists descriptor_multipath text;
alter table vaults add column if not exists descriptor_receive text;
alter table vaults add column if not exists descriptor_change text;
-- Which derivation rule made the v2 descriptors (1 = protocol/src/ranged.rs
-- RangedVault, 2026-11-19), so a later rule can never be mistaken for the
-- one that issued old addresses.
alter table vaults add column if not exists ranged_format smallint;

alter table vaults drop constraint if exists vaults_descriptor_version_shape;
alter table vaults add constraint vaults_descriptor_version_shape check (
  (descriptor_version = 1
    and descriptor_multipath is null and descriptor_receive is null
    and descriptor_change is null and ranged_format is null)
  or
  (descriptor_version = 2
    and descriptor_multipath is not null and descriptor_receive is not null
    and descriptor_change is not null and ranged_format is not null)
);

-- 2. Receive and change counters, one row each per v2 vault -----------

create table if not exists vault_address_branches (
  vault_id   uuid not null references vaults(id) on delete cascade,
  branch     smallint not null check (branch in (0, 1)),   -- 0 receive, 1 change
  -- The next index to hand out. bigint so the counter can sit one past the
  -- last non-hardened index (2^31 - 1) without overflowing.
  next_index bigint not null default 0 check (next_index between 0 and 2147483648),
  primary key (vault_id, branch)
);

-- 3. Every address ever issued ------------------------------------------

create table if not exists vault_addresses (
  vault_id            uuid not null references vaults(id) on delete cascade,
  branch              smallint not null check (branch in (0, 1)),
  idx                 integer not null check (idx between 0 and 2147483647),
  address             text not null unique,
  script_pubkey       text not null,
  -- Checksum of the branch descriptor that derived it.
  descriptor_checksum text not null,
  issued_at           timestamptz not null default now(),
  issued_by           uuid,
  label               text,
  primary key (vault_id, branch, idx)
);

-- An address row must name the vault's current descriptor for its branch,
-- and an index that was actually reserved. Only the label may change later.
create or replace function vault_addresses_guard()
returns trigger language plpgsql as $$
declare
  v record;
  reserved bigint;
begin
  if tg_op = 'UPDATE' then
    if (new.vault_id, new.branch, new.idx, new.address, new.script_pubkey, new.descriptor_checksum, new.issued_at, new.issued_by)
       is distinct from
       (old.vault_id, old.branch, old.idx, old.address, old.script_pubkey, old.descriptor_checksum, old.issued_at, old.issued_by) then
      raise exception 'an issued address never changes (vault %, branch %, index %)', old.vault_id, old.branch, old.idx;
    end if;
    return new;
  end if;
  select descriptor_version, descriptor_receive, descriptor_change into v from vaults where id = new.vault_id;
  if v.descriptor_version is distinct from 2 then
    raise exception 'vault % has one fixed address; it does not issue addresses', new.vault_id;
  end if;
  if new.descriptor_checksum is distinct from split_part(case new.branch when 0 then v.descriptor_receive else v.descriptor_change end, '#', 2) then
    raise exception 'address for vault % was not derived from its stored descriptor (checksum %)', new.vault_id, new.descriptor_checksum;
  end if;
  select next_index into reserved from vault_address_branches where vault_id = new.vault_id and branch = new.branch;
  if reserved is null or new.idx >= reserved then
    raise exception 'index % on branch % of vault % was never reserved', new.idx, new.branch, new.vault_id;
  end if;
  return new;
end $$;

drop trigger if exists vault_addresses_guard on vault_addresses;
create trigger vault_addresses_guard
  before insert or update on vault_addresses
  for each row execute function vault_addresses_guard();

-- 4. Reserving the next index: one statement, row-locked -----------------

create or replace function reserve_vault_address_index(p_vault_id uuid, p_branch smallint)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_version smallint;
  v_status  text;
  v_idx     bigint;
begin
  if p_branch not in (0, 1) then
    raise exception 'branch must be 0 (receive) or 1 (change)';
  end if;
  select descriptor_version, status into v_version, v_status from vaults where id = p_vault_id;
  if v_status is null then
    raise exception 'vault % not found', p_vault_id;
  end if;
  if v_status = 'draft' then
    raise exception 'vault % is still a draft', p_vault_id;
  end if;
  if v_version <> 2 then
    raise exception 'vault % has one fixed address (version 1)', p_vault_id;
  end if;
  insert into vault_address_branches (vault_id, branch) values (p_vault_id, p_branch)
    on conflict (vault_id, branch) do nothing;
  -- Postgres locks the row for this UPDATE, so concurrent callers queue and
  -- each gets the next number. An index reserved but never recorded is
  -- burned, never handed out again.
  update vault_address_branches
     set next_index = next_index + 1
   where vault_id = p_vault_id and branch = p_branch
  returning next_index - 1 into v_idx;
  if v_idx > 2147483647 then
    raise exception 'vault % has used every index on branch %', p_vault_id, p_branch;
  end if;
  return v_idx::integer;
end $$;

revoke all on function reserve_vault_address_index(uuid, smallint) from public, anon, authenticated;
grant execute on function reserve_vault_address_index(uuid, smallint) to service_role;

-- 5. A compiled vault's descriptor and keys never change -----------------
-- Once a vault is not a draft, any change to what defines its addresses
-- raises -- for every caller, the server's service-role key included.
-- key_origins (the key paths a hardware wallet signs with) may go from
-- empty to filled once, never from one value to another (operator,
-- 2026-11-19). A deliberate repair like 20260816194321 must disable this
-- trigger BY NAME in a migration a reviewer can see.

create or replace function vaults_freeze_compiled()
returns trigger language plpgsql as $$
begin
  if old.status = 'draft' then
    return new;
  end if;
  if (new.address, new.descriptor, new.descriptor_version, new.descriptor_multipath,
      new.descriptor_receive, new.descriptor_change, new.ranged_format, new.address_type,
      new.leaves, new.leaf_scripts, new.founder_keys, new.heir_keys, new.backup_keys,
      new.second_heir_keys, new.consent_keys, new.protector_keys, new.bloc_policy)
     is distinct from
     (old.address, old.descriptor, old.descriptor_version, old.descriptor_multipath,
      old.descriptor_receive, old.descriptor_change, old.ranged_format, old.address_type,
      old.leaves, old.leaf_scripts, old.founder_keys, old.heir_keys, old.backup_keys,
      old.second_heir_keys, old.consent_keys, old.protector_keys, old.bloc_policy) then
    raise exception 'vault % is compiled: its address, descriptor and keys never change', old.id;
  end if;
  if new.key_origins is distinct from old.key_origins
     and coalesce(jsonb_array_length(old.key_origins), 0) > 0 then
    raise exception 'vault % already has its key paths; they are filled once and never replaced', old.id;
  end if;
  if new.status = 'draft' then
    raise exception 'vault % is compiled and cannot go back to a draft', old.id;
  end if;
  return new;
end $$;

drop trigger if exists vaults_freeze_compiled on vaults;
create trigger vaults_freeze_compiled
  before update on vaults
  for each row execute function vaults_freeze_compiled();

-- 6. Who can read; nobody but the server writes ---------------------------

alter table vault_address_branches enable row level security;
alter table vault_addresses enable row level security;

drop policy if exists "member_reads_vault_addresses" on vault_addresses;
create policy "member_reads_vault_addresses" on vault_addresses for select using (
  exists (select 1 from vaults v where v.id = vault_addresses.vault_id and v.user_id = auth.uid())
  or is_vault_member(vault_addresses.vault_id)
);
drop policy if exists "member_reads_vault_address_branches" on vault_address_branches;
create policy "member_reads_vault_address_branches" on vault_address_branches for select using (
  exists (select 1 from vaults v where v.id = vault_address_branches.vault_id and v.user_id = auth.uid())
  or is_vault_member(vault_address_branches.vault_id)
);

revoke insert, update, delete, truncate on vault_addresses, vault_address_branches from anon, authenticated;

notify pgrst, 'reload schema';
