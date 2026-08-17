-- ============================================================
-- 042_leaf_list_vaults.sql
-- Generic leaf-list vault storage (the "toggle-a-leaf" builder).
--
-- A leaf-list vault replaces the named founder/heir/recovery/
-- inheritance/protector/backup/second_heir columns with one ordered
-- array describing every leaf the same way: who (a quorum of keys),
-- when (immediate, an absolute deadline, or a short self-refreshing
-- relative window), and an optional decay ladder. Presence of
-- `leaves` marks a row as leaf-list-shaped, the same discriminator
-- pattern migration 023 established for `bloc_policy` -- the standard
-- founder/heir columns and migration 026's `leaf_scripts` (compiled
-- script BYTES keyed by role name, an unrelated column despite the
-- similar name) stay exactly as they are, forever, serving every
-- vault compiled before this existed. Nothing here is read by, or
-- migrates, an existing vault.
--
-- `leaves` shape (mirrors protocol::LeafPolicy / compiler/src/main.rs's
-- LeafSpecWire -- see CLAUDE.md's timelock section for after()/older()):
--   [
--     {
--       "id": "primary",              -- caller-chosen, stable identifier;
--                                      -- this is what proposals.path names
--       "label": "Founders",          -- plain-language display label
--       "keys": ["66hex", ...],       -- pubkey hex, matches LeafSpecWire.keys
--       "quorum": 2,
--       "unlock": {"type": "immediate"}
--               | {"type": "after", "blocks": <absolute height>}
--               | {"type": "older", "blocks": <duration, capped by
--                  protocol::MAX_RELATIVE_BLOCKS>},
--       "decay": {"step_blocks": <duration>, "floor_quorum": 1} | null
--     },
--     ...
--   ]
--
-- `consent_keys` / `consent_quorum` (already existing, generic columns
-- from the named-field shape) keep gating the primary leaf the same
-- way for both shapes -- no new column needed, see LeafPolicy's own
-- doc comment in policy_compiler.rs for why consent stays a modifier
-- rather than a leaf of its own. `key_origins` (migration 038) is
-- already a flat array independent of role, so it needs no change
-- either.
-- ============================================================

alter table vaults
  add column if not exists leaves jsonb;

-- proposals.path is a fixed enum today; a leaf-list vault's leaf ids
-- are caller-chosen and can't be enumerated in a check constraint.
-- Drop the constraint in favor of app-level validation (the Netlify
-- function that files a proposal already looks up the vault's own
-- policy before accepting a path) -- the alternative, widening the
-- enum forever, doesn't scale to arbitrary custom leaf ids.
alter table proposals
  drop constraint if exists proposals_path_check;
