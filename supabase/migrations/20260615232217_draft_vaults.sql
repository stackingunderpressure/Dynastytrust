-- ============================================================
-- 006_draft_vaults.sql
-- Draft-vault lifecycle: a vault is created with a planned shape
-- (founders, heirs, timelocks) but no compiled descriptor. Members
-- join via invites and provide their xpub. When every slot is
-- filled, the owner presses Compile and the Rust service produces
-- the final descriptor + address.
--
-- Backward compatible: every existing vault has a descriptor
-- already, so the migration marks them status='compiled'. Address,
-- descriptor, and miniscript_policy become nullable so drafts
-- don't need them until compile time.
-- ============================================================

alter table vaults
  add column if not exists status text not null default 'compiled'
    check (status in ('draft', 'compiled', 'archived')),
  add column if not exists planned_founder_count integer,
  add column if not exists planned_heir_count integer;

-- Drafts don't have these yet; existing rows already carry them.
alter table vaults alter column address drop not null;
alter table vaults alter column descriptor drop not null;
alter table vaults alter column miniscript_policy drop not null;

create index if not exists vaults_status_idx on vaults(status);

-- Events emitted by the new flow. No change to the table; the
-- event_type column is text, and these are just the values the
-- backend writes:
--   draft_created
--   slot_filled
--   draft_compiled
