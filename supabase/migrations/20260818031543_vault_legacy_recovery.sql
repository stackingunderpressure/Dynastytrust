-- ============================================================
-- vault_legacy_recovery.sql
-- Long-horizon descriptor recovery ("Legacy Recovery" -- see
-- apps/web/src/lib/legacy-recovery.ts for the crypto core). Three
-- tables, all storing data that is either already encrypted/locked to a
-- specific keyholder's own key, or deliberately unlocked-by-design (the
-- on-chain share, whose entire purpose is being safe to publish in the
-- open). A full breach of this schema alone never exposes a descriptor:
-- the sealed bundle needs the split secret, the split secret needs at
-- least two shares, and every keyholder share is locked to a key this
-- database never holds.
--
-- vault_legacy_bundles: the AES-256-GCM-sealed recovery bundle (the
-- descriptor + policy text), one row per vault, overwritten whenever the
-- vault recompiles.
--
-- vault_legacy_shares: one row per (vault, key_role) -- that role's
-- locked fast-path share and locked Shamir-fallback share. Locked with a
-- value only that role's own key can reproduce (deriveLegacyLockBytes);
-- this table never sees an unlocked share.
--
-- vault_legacy_onchain_shares: the single unlocked on-chain pad per
-- vault, plus publication metadata (txid/published_at) filled in once a
-- later, separate, deliberate step actually broadcasts it. Storing it
-- here BEFORE on-chain publication lets the fast recovery path work
-- immediately -- publication only adds durability independent of this
-- database, it isn't required for the feature to function.
-- ============================================================

create table if not exists vault_legacy_bundles (
  vault_id       uuid primary key references vaults(id) on delete cascade,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  nonce_b64      text not null,
  ciphertext_b64 text not null
);

drop trigger if exists vault_legacy_bundles_updated_at on vault_legacy_bundles;
create trigger vault_legacy_bundles_updated_at before update on vault_legacy_bundles
  for each row execute function touch_updated_at();

alter table vault_legacy_bundles enable row level security;

drop policy if exists "members_see_legacy_bundle" on vault_legacy_bundles;
create policy "members_see_legacy_bundle"
  on vault_legacy_bundles for select using (is_vault_member(vault_id));

create table if not exists vault_legacy_shares (
  id                        uuid primary key default gen_random_uuid(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  vault_id                  uuid not null references vaults(id) on delete cascade,
  key_role                  text not null,
  locked_fast_share_b64     text not null,
  locked_fallback_share_b64 text not null,
  unique (vault_id, key_role)
);

create index if not exists vault_legacy_shares_vault_id_idx on vault_legacy_shares(vault_id);

drop trigger if exists vault_legacy_shares_updated_at on vault_legacy_shares;
create trigger vault_legacy_shares_updated_at before update on vault_legacy_shares
  for each row execute function touch_updated_at();

alter table vault_legacy_shares enable row level security;

drop policy if exists "members_see_legacy_shares" on vault_legacy_shares;
create policy "members_see_legacy_shares"
  on vault_legacy_shares for select using (is_vault_member(vault_id));

create table if not exists vault_legacy_onchain_shares (
  vault_id        uuid primary key references vaults(id) on delete cascade,
  created_at      timestamptz not null default now(),
  onchain_share_b64 text not null,
  txid            text,
  published_at    timestamptz
);

alter table vault_legacy_onchain_shares enable row level security;

drop policy if exists "members_see_legacy_onchain_share" on vault_legacy_onchain_shares;
create policy "members_see_legacy_onchain_share"
  on vault_legacy_onchain_shares for select using (is_vault_member(vault_id));
