-- ============================================================
-- 018_vault_predecessor.sql
-- Chain vaults together across rotations. A vault's
-- `predecessor_id` points to the vault it replaced; the forward
-- link (successor) is derived by reverse lookup.
--
-- Rotation creates a new DRAFT vault with an identical shape
-- (members, trust doc, quorums, timelocks) plus predecessor_id
-- set. The trust layer lives across the chain; the on-chain
-- address rotates underneath.
-- ============================================================

alter table vaults
  add column if not exists predecessor_id uuid references vaults(id) on delete set null;

create index if not exists vaults_predecessor_idx
  on vaults(predecessor_id);
