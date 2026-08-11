-- ============================================================
-- 031_second_inheritance_path.sql
-- Second, independent inheritance leaf (2026-08-11). A distinct
-- heir cohort with its own key set, quorum, and absolute timelock
-- alongside the primary heir_keys/heir_quorum/inheritance_after
-- leaf -- e.g. a spouse who unlocks sooner on a shorter horizon,
-- extended family later on a longer one. Deliberately UNORDERED
-- relative to inheritance_after (either shorter or longer is a
-- valid design); see DynastyPolicy::has_second_inheritance in
-- protocol/src/policy_compiler.rs. Requires the primary
-- inheritance leaf to already be configured (heir_keys non-empty)
-- -- the Rust compiler rejects a policy that sets a second cohort
-- without a first (SecondInheritanceRequiresInheritance).
-- ============================================================

alter table vaults
  add column if not exists second_heir_keys        jsonb not null default '[]'::jsonb,
  add column if not exists second_heir_quorum       integer,
  add column if not exists second_inheritance_after integer;

alter table proposals
  drop constraint if exists proposals_path_check;

alter table proposals
  add constraint proposals_path_check
  check (path in (
    'founders_now', 'recovery', 'inheritance', 'protector', 'backup', 'second_inheritance',
    'parents_now', 'coparent_kids', 'parent_solo', 'kids_decay'
  ));
