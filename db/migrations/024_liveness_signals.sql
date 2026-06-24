-- ============================================================
-- 024_liveness_signals.sql
-- Verified liveness-signal store for the fail-closed signing gate.
--
-- The liveness gate (packages/policy-engine evaluateSigningGate)
-- denies a spend leg when a circle member is RED (a verifying
-- in-group duress flag) or when fresh GREEN heartbeats fall short
-- of the leg's required count. The signals that feed that gate --
-- signed proof-of-life heartbeats and signed duress flags -- are
-- held in this table.
--
-- WHERE THE CONFIG LIVES (NOT a column here):
--   The vault's liveness CONFIG rides inside the existing
--   vaults.bloc_policy jsonb under a `liveness` sub-object:
--     bloc_policy.liveness = {
--       "circle":              ["64hex x-only pubkey", ...],
--       "requiredGreenByPath": { "parents_now": 2, ... },
--       "ttlSeconds":          <positive number>
--     }
--   No new vaults column is added. loadVaultLivenessConfig
--   (netlify/functions/_liveness.js) reads + validates that
--   sub-object; a missing or malformed `liveness` means the vault
--   is simply NOT liveness-gated (safe default -- never a fake green).
--
-- WHAT THIS TABLE HOLDS (signals only, all PUBLIC material):
--   Each row is one signed attestation -- a ProofOfLife or a
--   DuressFlag from tapit-attest. Everything here is public: x-only
--   public keys, timestamps, and BIP340 Schnorr signatures. No
--   private key material ever touches this table.
--
-- VERIFY-ON-WRITE (the security core, enforced in the function):
--   Rows are written ONLY through the service-role netlify function
--   (netlify/functions/liveness.js), which calls
--   verifyLivenessSignalForStorage BEFORE insert. A signal whose
--   Schnorr signature does not verify -- forged, tampered, unsigned,
--   or garbage -- is rejected with 400 and is NEVER stored. The DB
--   itself cannot re-run Schnorr, so the function is the gate; RLS
--   below only governs READS.
-- ============================================================

create table if not exists liveness_signals (
  id          uuid primary key default gen_random_uuid(),
  vault_id    uuid not null references vaults(id) on delete cascade,
  -- x-only public key (64 hex) of the SUBJECT this signal is about.
  -- For proof-of-life subject == signer; for duress-flag it is the
  -- person being flagged.
  subject     text not null,
  kind        text not null check (kind in ('proof-of-life','duress-flag')),
  -- The full signed attestation as minted by tapit-attest, stored
  -- verbatim so the GET path can hand it straight to
  -- assembleLivenessGateInput / livenessStateFor, which re-verifies.
  signal      jsonb not null,
  -- x-only pubkey of the peer who raised a duress flag. NULL for
  -- proof-of-life (a heartbeat is self-signed; there is no separate
  -- raiser).
  raised_by   text,
  created_at  timestamptz not null default now()
);

-- The gate loads a vault's signals by (vault_id, subject): the latest
-- heartbeat per subject and that subject's red flags.
create index if not exists liveness_signals_vault_subject_idx
  on liveness_signals(vault_id, subject);

alter table liveness_signals enable row level security;

-- Reads: any active member/owner of the vault may read its signals,
-- matching the vault-scoped ownership model used by
-- vault_attestations (020) and friends. Writes are NOT exposed to
-- anon/authenticated clients -- they go through the service-role
-- function, which holds the verify-on-write gate, so no INSERT/UPDATE
-- policy is granted here.
drop policy if exists "members_see_liveness_signals" on liveness_signals;
create policy "members_see_liveness_signals"
  on liveness_signals for select using (is_vault_member(vault_id));

alter publication supabase_realtime add table liveness_signals;
