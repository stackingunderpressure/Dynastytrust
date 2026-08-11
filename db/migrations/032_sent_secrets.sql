-- ============================================================
-- 032_sent_secrets.sql
-- Recoverable record of secrets the owner has sent to circle members
-- (starting with the circle safety phrase pair) -- operator, 2026-08-11:
-- "there's a way that you can see the secret that you sent because if
-- you forgot, then you're not gonna be able to say the right thing...
-- it doesn't need to be sitting in plain text, but it does need to be
-- able to be revealed with your password."
--
-- Same posture as 030_messaging_key_backup.sql: the browser encrypts the
-- secret fields (AES-256-GCM, PBKDF2 210,000 rounds, via keystore.ts's
-- existing encryptText/decryptBlob) under a password the owner sets, and
-- only the ciphertext + salt + nonce are ever sent here. The server (and
-- anyone reading this table directly) sees only ciphertext plus the
-- non-secret bookkeeping (which vault, what kind of secret, who it was
-- sent to, when) -- never the phrase itself.
-- ============================================================

create table if not exists sent_secrets (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  vault_id      uuid not null references vaults(id) on delete cascade,

  -- What kind of secret this is (extensible -- circle_phrase today,
  -- more kinds later e.g. descriptor-recovery shares) and a short
  -- human label for display.
  kind          text not null,
  label         text not null,

  -- Non-secret bookkeeping: who this was sent to, so "I told this
  -- person this for this vault" is answerable without decrypting
  -- anything. [{label, persona}, ...].
  recipients    jsonb not null default '[]'::jsonb,

  -- The encrypted secret fields (a JSON object, e.g.
  -- {"normalPhrase": "...", "duressPhrase": "..."}), AES-256-GCM
  -- under a password-derived key. Never plaintext.
  ciphertext_b64 text not null,
  salt_b64       text not null,
  nonce_b64      text not null
);

create index if not exists sent_secrets_vault_id_idx on sent_secrets(vault_id);
create index if not exists sent_secrets_user_id_idx  on sent_secrets(user_id);

alter table sent_secrets enable row level security;

drop policy if exists "owner_select_own_secrets" on sent_secrets;
create policy "owner_select_own_secrets"
  on sent_secrets for select using (auth.uid() = user_id);

drop policy if exists "owner_insert_own_secrets" on sent_secrets;
create policy "owner_insert_own_secrets"
  on sent_secrets for insert with check (auth.uid() = user_id);

drop policy if exists "owner_delete_own_secrets" on sent_secrets;
create policy "owner_delete_own_secrets"
  on sent_secrets for delete using (auth.uid() = user_id);
