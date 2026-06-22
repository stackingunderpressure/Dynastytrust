-- ============================================================
-- 023_bloc_vaults.sql
-- Dynasty Bloc persistence + the duress hold for the fail-closed
-- signing gate.
--
-- A Bloc vault is a decaying-multisig family Taproot vault whose
-- shape (parents/kids, several quorums, two timelocks + a decay
-- step) does not fit the founders/heirs columns. Rather than a
-- column per field, we store the whole policy as one jsonb blob;
-- presence of `bloc_policy` marks a row as a Bloc vault. The
-- standard address / descriptor / miniscript_policy / address_type /
-- network / name columns are reused.
--
-- `bloc_policy` shape (all values the compiler needs to rebuild the
-- exact tree for a spend, so they MUST match what compile baked):
--   {
--     "parent_pubkeys": ["66hex", ...],   -- /0/0 child pubkeys (tree)
--     "kid_pubkeys":    ["66hex", ...],
--     "parent_xpubs":   ["xpub...", ...],  -- for descriptor / export
--     "kid_xpubs":      ["xpub...", ...],
--     "parents_together_quorum": 2,
--     "coparent_quorum": 1,
--     "kids_with_parent_quorum": 4,
--     "parent_solo_quorum": 1,
--     "kids_decay_start_quorum": 4,
--     "kids_decay_floor_quorum": 1,
--     "parent_solo_after": <absolute height>,
--     "kids_decay_start_after": <absolute height>,
--     "kids_decay_step_blocks": <duration>
--   }
--
-- `duress` is a vault-level hold. When true, the fail-closed signing
-- gate denies (DURESS_HOLD) and funds fall to the timelock backstop --
-- the only on-chain enforcement; the flag itself just stops the app
-- from helping. RLS already protects vaults rows, so no new policy.
-- ============================================================

alter table vaults
  add column if not exists bloc_policy jsonb,
  add column if not exists duress      boolean not null default false;

-- Allow the Bloc spend paths on proposals. The original constraint only
-- permitted the founders/heirs paths; widen it so a Bloc proposal can
-- record which leaf it spends (the decay rung's quorum rides in
-- governance_audit jsonb, no new column).
alter table proposals
  drop constraint if exists proposals_path_check;

alter table proposals
  add constraint proposals_path_check
  check (path in (
    'founders_now', 'recovery', 'inheritance', 'protector',
    'parents_now', 'coparent_kids', 'parent_solo', 'kids_decay'
  ));
