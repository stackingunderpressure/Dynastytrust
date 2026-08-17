-- ============================================================
-- 004_seed_existing_owners.sql
-- Backfill vault_members for every vault that existed before
-- migration 003. Safe to re-run (ON CONFLICT DO NOTHING).
-- ============================================================

insert into vault_members (vault_id, user_id, role, label, status)
select id, user_id, 'owner', 'Owner', 'active'
from vaults
on conflict (vault_id, user_id) do nothing;
