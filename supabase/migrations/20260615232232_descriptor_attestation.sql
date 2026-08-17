-- ============================================================
-- 021_descriptor_attestation.sql
-- Extends the attestation_type allowlist to include 'descriptor'.
-- Same signing mechanism as trust_doc attestations (Schnorr sig
-- by the member's Bitcoin key under a domain-separated tag),
-- but the target_hash is the SHA-256 of the vault's compiled
-- descriptor string.
--
-- Why: protects against an attacker who breaches the database and
-- swaps the vault's address. Changing the descriptor invalidates
-- every prior attestation because its SHA-256 digest changes.
-- Members then see "0 of N attested" and refuse to sign until
-- they re-attest to the new descriptor (which, if legitimate,
-- they would do after verifying).
-- ============================================================

alter table vault_attestations
  drop constraint if exists vault_attestations_attestation_type_check;

alter table vault_attestations
  add constraint vault_attestations_attestation_type_check
  check (attestation_type in ('trust_doc', 'proof_of_life', 'death_declaration', 'descriptor'));
