-- ============================================================
-- 019_e2e_messaging.sql
-- Per-vault encrypted message thread. Server sees only ciphertext;
-- each recipient unwraps the message key via their own X25519
-- private key which never leaves their browser.
--
-- messaging_pubkey: each member publishes an X25519 public key
--   the FIRST time they open a vault they're a member of. The
--   private counterpart stays in the sender / recipient browser
--   (localStorage). Keys rotate when the user clears storage or
--   explicitly regenerates.
--
-- vault_messages: each row is one message. `sender_pubkey` is the
--   X25519 pubkey the sender used (lets recipients verify who
--   encrypted and recompute the ECDH shared secret). `nonce` +
--   `ciphertext` hold the AEAD-encrypted body keyed by a random
--   per-message symmetric key. `recipients` is a jsonb array of
--   { user_id, pubkey, wrap_nonce, wrapped_key } -- one entry
--   per vault member so each recipient can unwrap K with their
--   own X25519 private key.
-- ============================================================

alter table vault_members
  add column if not exists messaging_pubkey text;

create table if not exists vault_messages (
  id                  uuid primary key default gen_random_uuid(),
  vault_id            uuid not null references vaults(id) on delete cascade,
  sender_user_id      uuid not null,
  sender_pubkey       text not null,
  created_at          timestamptz not null default now(),
  subject             text,
  thread_id           uuid,
  nonce               text not null,
  ciphertext          text not null,
  recipients          jsonb not null default '[]'::jsonb
);

create index if not exists vault_messages_vault_idx
  on vault_messages(vault_id, created_at desc);
create index if not exists vault_messages_thread_idx
  on vault_messages(thread_id, created_at);

alter table vault_messages enable row level security;

drop policy if exists "members_see_messages" on vault_messages;
create policy "members_see_messages"
  on vault_messages for select using (is_vault_member(vault_id));

alter publication supabase_realtime add table vault_messages;
