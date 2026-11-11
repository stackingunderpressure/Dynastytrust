-- Family joins with their own keys (journey gap J3, agreed 2026-11-11).
--
-- A vault built with the path builder has no founder/heir roles: an
-- invite is for ONE key slot on ONE named path. These columns record
-- which path an invite and the resulting member are for, and that the
-- owner has confirmed the member's key by its fingerprint. Only a
-- confirmed key may be compiled into a vault (compile-leaves.js).
--
-- Idempotent. Adds nullable columns only: every existing row keeps
-- working exactly as before (leaf_id null = the older role-based
-- invite; key_confirmed_at null = not confirmed).

alter table vault_invites
  add column if not exists leaf_id text;

alter table vault_members
  add column if not exists leaf_id text,
  add column if not exists key_confirmed_at timestamptz,
  add column if not exists key_confirmed_by uuid references auth.users(id) on delete set null;

comment on column vault_invites.leaf_id is
  'Path-builder vaults: the id of the spending path (vaults.leaves[].id) this invite fills a key slot on.';
comment on column vault_members.leaf_id is
  'Path-builder vaults: the path this member was invited to hold a key on.';
comment on column vault_members.key_confirmed_at is
  'When the vault owner confirmed this member''s key by its fingerprint. Cleared if the key is ever changed.';
