-- ============================================================
-- 036_tranche_claim_proposals.sql
-- Tranche claims become real proposals (2026-08-12, operator:
-- "make sure that any requests regardless of what they are get
-- filed under something ... every PSBT has some kind of request
-- tied to it ... especially in the bigger vaults"). Distribution-
-- wallet ("T-vesting") tranche claims previously broadcast a PSBT
-- and recorded only claimed_txid on distribution_wallets.tranches
-- -- no proposals row, so no voting, no discussion thread, no
-- audit history, nothing the rest of the governance UI already
-- gives every standard and Bloc spend. This migration widens the
-- path check to accept 'tranche_claim' and adds two nullable
-- linkage columns so a proposal can point back at the exact
-- distribution wallet + tranche it claims -- standard/Bloc
-- proposals leave both null.
-- ============================================================

alter table proposals
  add column if not exists distribution_wallet_id uuid references distribution_wallets(id) on delete set null,
  add column if not exists tranche_index integer;

create index if not exists proposals_distribution_wallet_id_idx
  on proposals(distribution_wallet_id);

alter table proposals
  drop constraint if exists proposals_path_check;

alter table proposals
  add constraint proposals_path_check
  check (path in (
    'founders_now', 'recovery', 'inheritance', 'protector', 'backup', 'second_inheritance',
    'parents_now', 'coparent_kids', 'parent_solo', 'kids_decay',
    'tranche_claim'
  ));
