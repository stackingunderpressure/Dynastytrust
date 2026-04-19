-- ============================================================
-- 017_event_block_height.sql
-- Stamp each vault event with the chain tip at time of emission
-- so the audit trail can correlate app-level actions with
-- on-chain position. Historical events stay NULL -- we can't
-- backfill a tip we never recorded.
--
-- The block height is written best-effort by the emitting
-- function (it fetches from mempool.space). A missed fetch is
-- not fatal; the event still records the timestamp.
-- ============================================================

alter table vault_events
  add column if not exists block_height integer;

create index if not exists vault_events_vault_block_idx
  on vault_events(vault_id, block_height);
