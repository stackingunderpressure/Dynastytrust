-- ============================================================
-- 026_leaf_scripts.sql
-- Per-role tapscript leaf bytes for a compiled tr_multileaf vault --
-- the data source for Cut C3 (vault-membership attestation minting).
--
-- `leaf_scripts` shape (hex-encoded ScriptBuf per role, only the roles
-- the policy actually compiled -- matches CompileResponse.leaf_scripts
-- from the Fly.io compiler, compiler/src/main.rs):
--   {
--     "founders_now": "51 20 ... hex",
--     "recovery":     "hex" | absent,
--     "inheritance":  "hex" | absent,
--     "protector":    "hex" | absent
--   }
--
-- Stored at compile time so a vault-membership attestation can be
-- (re)minted and (re)sent to a Tapit circle member's wallet any time
-- after compile -- e.g. resending to a device that lost the wallet, or
-- adding a late circle member -- without a second round trip to the
-- Fly.io compiler. Null for non-tr_multileaf vaults (wsh, tr, and Bloc
-- vaults, which store their own tree shape in bloc_policy instead).
-- ============================================================

alter table vaults
  add column if not exists leaf_scripts jsonb;
