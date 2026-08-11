-- ============================================================
-- 034_circle_phrase_deliveries.sql
-- Persisted send-status for the circle safety phrase pair
-- (operator, viewing the "Send" tab after reload): "These phrases should
-- show they've been sent and not do it again and again. And have a
-- change button to edit it."
--
-- CirclePhraseSetup.tsx's sent-status used to live only in local
-- useState -- gone the moment the page reloaded, so the card always
-- looked like nothing had ever been sent and invited a resend every
-- time the owner came back to it. This table records, per (vault,
-- recipient), that a delivery happened and when -- never the phrase
-- text itself, which stays exactly as un-persisted as before (still
-- only ever leaves the browser NIP-44 encrypted straight to the
-- recipient's Tapit pubkey; see circle-phrase-delivery.ts).
-- ============================================================

create table if not exists circle_phrase_deliveries (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  vault_id           uuid not null references vaults(id) on delete cascade,

  recipient_key_id   text not null,   -- local keystore LocalKey.keyId
  recipient_label    text not null,
  recipient_persona  text not null default '',

  status             text not null default 'delivered' check (status in ('delivered', 'queued')),
  delivered_at       timestamptz not null default now(),

  unique (vault_id, recipient_key_id)
);

create index if not exists circle_phrase_deliveries_vault_id_idx on circle_phrase_deliveries(vault_id);
create index if not exists circle_phrase_deliveries_user_id_idx  on circle_phrase_deliveries(user_id);

alter table circle_phrase_deliveries enable row level security;

drop policy if exists "owner_select_own_phrase_deliveries" on circle_phrase_deliveries;
create policy "owner_select_own_phrase_deliveries"
  on circle_phrase_deliveries for select using (auth.uid() = user_id);

drop policy if exists "owner_upsert_own_phrase_deliveries" on circle_phrase_deliveries;
create policy "owner_upsert_own_phrase_deliveries"
  on circle_phrase_deliveries for insert with check (auth.uid() = user_id);

drop policy if exists "owner_update_own_phrase_deliveries" on circle_phrase_deliveries;
create policy "owner_update_own_phrase_deliveries"
  on circle_phrase_deliveries for update using (auth.uid() = user_id);
