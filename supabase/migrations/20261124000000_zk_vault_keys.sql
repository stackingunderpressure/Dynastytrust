-- ============================================================
-- Zero-knowledge storage, Z1 slice 1 (docs/zero-knowledge-storage-plan.md).
--
-- vault_keys: one row per (vault, key version, recipient member, recipient
-- messaging key, wrapper) -- a member on a new device gets a fresh row.
-- `wrap` is lib/messaging.ts EncryptedMessage JSON: the vault key wrapped to
-- the recipient's X25519 messaging pubkey. The server cannot open it.
--
-- vaults.vault_key_version: current key version (0 = none yet).
-- vaults.vault_key_checks: {"<version>": "<hmac check>"} published by the
--   owner, so members only accept a wrap that opens to the owner's real key.
--
-- proposal_comments.sealed: comment body + vote sealed with the vault key.
-- reply_privkey_sealed (grants, phrase deliveries): the Nostr ack reply key,
--   wrapped to the owner's own messaging key instead of stored readable.
-- Additive only; nothing is dropped and no data is changed here.
-- ============================================================

create table if not exists vault_keys (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  vault_id           uuid not null references vaults(id) on delete cascade,
  version            integer not null check (version >= 1),
  recipient_user_id  uuid not null references auth.users(id) on delete cascade,
  recipient_pubkey   text not null,  -- messaging pubkey the wrap was made to
  created_by         uuid not null references auth.users(id) on delete cascade,
  wrap               jsonb not null,
  unique (vault_id, version, recipient_user_id, recipient_pubkey, created_by)
);

create index if not exists vault_keys_vault_version_idx on vault_keys(vault_id, version);
create index if not exists vault_keys_recipient_idx on vault_keys(recipient_user_id);

alter table vault_keys enable row level security;
drop policy if exists "recipient_reads_own_vault_keys" on vault_keys;
create policy "recipient_reads_own_vault_keys" on vault_keys
  for select using (auth.uid() = recipient_user_id);
revoke insert, update, delete, truncate on vault_keys from anon, authenticated;

alter table vaults add column if not exists vault_key_version integer not null default 0;
alter table vaults add column if not exists vault_key_checks jsonb not null default '{}'::jsonb;

alter table proposal_comments add column if not exists sealed text;
alter table proposal_comments drop constraint if exists proposal_comments_non_empty;
alter table proposal_comments add constraint proposal_comments_non_empty
  check (body is not null or vote is not null or sealed is not null);

alter table vault_membership_grants add column if not exists reply_privkey_sealed jsonb;
alter table vault_membership_grants alter column reply_privkey drop not null;
alter table circle_phrase_deliveries add column if not exists reply_privkey_sealed jsonb;
