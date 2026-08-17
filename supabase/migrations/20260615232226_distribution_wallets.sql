-- ============================================================
-- 015_distribution_wallets.sql
-- T-vesting: child "distribution wallet" with N tranches that
-- unlock at absolute block heights (CLTV). A main vault funds
-- the distribution wallet by sending sats to each tranche
-- address. When a tranche unlocks at its target block, the
-- beneficiary can claim it alone (single signature). Trustees
-- retain an escape hatch on every tranche so an unclaimed
-- tranche can be recompounded, redirected, or rescued.
--
-- Each tranche has its own Taproot address + descriptor:
--   tr(NUMS, {
--     and(after(abs_block_N), pk(beneficiary)),
--     thresh(TrusteeQ, trustees)
--   })
--
-- The 'tranches' JSON stores one entry per tranche:
--   {
--     index: 0,
--     unlock_block: 864000,
--     amount_sats: 1000000,
--     address: "bc1p...",
--     descriptor: "tr(...)/0/*",
--     funded_txid: "abc..." | null,
--     claimed_txid: "def..." | null
--   }
-- ============================================================

create table if not exists distribution_wallets (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  vault_id            uuid not null references vaults(id) on delete cascade,
  name                text not null,
  beneficiary_name    text,
  beneficiary_xpub    text not null,
  beneficiary_pubkey  text not null,

  -- Snapshot of the trustees + quorum captured at creation; the
  -- parent vault can change later (new draft compiles) but the
  -- distribution wallet's own address/descriptor are immutable.
  trustee_keys        jsonb not null default '[]'::jsonb,
  trustee_quorum      integer not null,

  tranches            jsonb not null default '[]'::jsonb,
  network             text not null check (network in ('testnet', 'bitcoin'))
);

create index if not exists distribution_wallets_vault_id_idx on distribution_wallets(vault_id);

drop trigger if exists distribution_wallets_updated_at on distribution_wallets;
create trigger distribution_wallets_updated_at before update on distribution_wallets
  for each row execute function touch_updated_at();

alter table distribution_wallets enable row level security;

drop policy if exists "members_see_distribution_wallets" on distribution_wallets;
create policy "members_see_distribution_wallets"
  on distribution_wallets for select using (is_vault_member(vault_id));

alter publication supabase_realtime add table distribution_wallets;
