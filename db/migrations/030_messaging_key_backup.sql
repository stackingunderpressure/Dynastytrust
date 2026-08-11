-- ============================================================
-- 030_messaging_key_backup.sql
-- Durable, passphrase-encrypted backup of a member's X25519
-- messaging private key (lib/messaging.ts), so opening the vault
-- from a new browser or after clearing site data does not
-- permanently lose access to past messages.
--
-- Operator, 2026-08-11, looking at the Messages tab's own warning
-- ("Your private key lives in this browser's local storage --
-- clearing site data wipes your ability to read past messages"):
-- "Need to fix the messaging to be Encrypted and all saved to
-- supa base. Not browser."
--
-- The private key is NEVER sent to the server in the clear -- that
-- would defeat the whole point of end-to-end encryption. Instead
-- the browser wraps the key with AES-256-GCM under a passphrase
-- the operator sets (PBKDF2, 210,000 rounds -- same primitives and
-- round count keystore.ts already uses for "secure mode" Bitcoin
-- keys), and only the wrapped ciphertext + salt + nonce are stored
-- here. The server can no more read this than it can read a
-- message; only someone who knows the passphrase can unwrap it.
-- One row per user (not per vault) -- the messaging keypair is
-- already long-term and shared across every vault a member belongs
-- to (lib/messaging.ts's own header comment).
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
