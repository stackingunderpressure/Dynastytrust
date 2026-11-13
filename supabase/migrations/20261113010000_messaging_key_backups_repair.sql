-- ============================================================
-- Repair: create messaging_key_backups on the live database.
--
-- Operator, 2026-11-13, screenshot of a vault's Messages tab:
-- "Could not check messaging-key backup status (Could not find the
-- table 'public.messaging_key_backups' in the schema cache)".
--
-- Root cause: 20260811000800_messaging_key_backup.sql was added in
-- the same commit (918c5e3, 2026-08-18) as the one-time bootstrap
-- (supabase-db-bootstrap.yml), which marked every file in this
-- folder as already applied WITHOUT running it, on the belief that
-- each had been pasted into the SQL editor by hand. This one never
-- was, so the deploy pipeline has skipped it ever since.
--
-- This file is that migration's SQL again, unchanged, under a new
-- version so the pipeline actually runs it. Every statement is
-- idempotent (if not exists / drop policy if exists), so on a
-- database that somehow already has the table it is a no-op.
-- Owner-only RLS, as before: the server stores only ciphertext.
-- ============================================================

create table if not exists messaging_key_backups (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  pubkey              text not null,
  wrapped_priv_b64    text not null,
  salt_b64            text not null,
  nonce_b64           text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table messaging_key_backups enable row level security;

drop policy if exists "owner_select_own_backup" on messaging_key_backups;
create policy "owner_select_own_backup"
  on messaging_key_backups for select using (auth.uid() = user_id);

drop policy if exists "owner_upsert_own_backup" on messaging_key_backups;
create policy "owner_upsert_own_backup"
  on messaging_key_backups for insert with check (auth.uid() = user_id);

drop policy if exists "owner_update_own_backup" on messaging_key_backups;
create policy "owner_update_own_backup"
  on messaging_key_backups for update using (auth.uid() = user_id);

-- Have PostgREST pick the new table up at once instead of on its
-- next cache refresh.
notify pgrst, 'reload schema';
