-- ============================================================
-- 033_vault_membership_grants.sql
-- Persisted "granted membership" state + accept/decline round trip
-- (operator, 2026-08-11, "Circle membership" tab): "I feel like we need
-- to make these answers persist and then we know that we've already
-- granted membership... we need to have a return roster of it or
-- something that tells it they've accepted... there's just not enough
-- communication on that part."
--
-- One row per (vault, role, key) a membership request was sent for.
-- `status` starts 'sent' and moves to 'accepted' or 'declined' once the
-- member's Tapit wallet publishes an acknowledgment back over the new
-- vault-membership-ack Nostr channel (kind 9580, lib/vault-membership-
-- ack-channel.ts) -- see that file's header for why 'sent' can persist
-- for hours or days before an ack ever arrives, unlike the short-lived
-- psbt-cosign response channel this is modeled on.
--
-- reply_privkey is an ephemeral, single-purpose NOSTR MESSAGING keypair
-- this app minted purely to receive the ack -- NOT a Bitcoin key and not
-- user secret material (it controls no funds, reveals no descriptor or
-- passphrase). Storing it here (unlike sent_secrets' password-encrypted
-- posture) is the deliberate departure from the psbt-cosign precedent's
-- "never persisted, session-only" reply key: a membership grant can sit
-- unanswered far longer than one browser tab stays open, so the key that
-- decrypts the eventual ack has to survive a reload, a different device,
-- or the tab being closed entirely.
-- ============================================================

create table if not exists vault_membership_grants (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  vault_id       uuid not null references vaults(id) on delete cascade,

  role           text not null,
  key_id         text not null,   -- local keystore LocalKey.keyId this grant targets
  recipient_label   text not null,
  recipient_persona text not null default '',
  recipient_pubkey  text not null, -- the member's real Tapit x-only pubkey

  request_event_id  text,          -- Nostr event id of the request send
  reply_pubkey      text not null, -- ephemeral ack-channel public half
  reply_privkey     text not null, -- ephemeral ack-channel private half (see header)

  status         text not null default 'sent' check (status in ('sent', 'accepted', 'declined')),
  responded_at   timestamptz,

  unique (vault_id, role, key_id)
);

create index if not exists vault_membership_grants_vault_id_idx on vault_membership_grants(vault_id);
create index if not exists vault_membership_grants_user_id_idx  on vault_membership_grants(user_id);
create index if not exists vault_membership_grants_reply_pubkey_idx on vault_membership_grants(reply_pubkey);

alter table vault_membership_grants enable row level security;

drop policy if exists "owner_select_own_grants" on vault_membership_grants;
create policy "owner_select_own_grants"
  on vault_membership_grants for select using (auth.uid() = user_id);

drop policy if exists "owner_insert_own_grants" on vault_membership_grants;
create policy "owner_insert_own_grants"
  on vault_membership_grants for insert with check (auth.uid() = user_id);

drop policy if exists "owner_update_own_grants" on vault_membership_grants;
create policy "owner_update_own_grants"
  on vault_membership_grants for update using (auth.uid() = user_id);
