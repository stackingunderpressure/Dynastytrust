-- ============================================================
-- 020_attestations.sql
-- Unified signed attestations for trust governance.
--
-- Three attestation_types live in this table:
--   trust_doc          -- member Schnorr-signs the hash of the
--                         current trust_doc JSON, confirming they
--                         have read + agreed to the terms.
--   proof_of_life      -- founder signs a fresh nonce periodically
--                         so heirs / trustees can prove they were
--                         alive at a given timestamp.
--   death_declaration  -- witnesses sign the same target_hash to
--                         declare a subject deceased. Governance
--                         signal only -- does NOT move the on-chain
--                         CLTV. Informs rotation / inheritance prep.
--
-- Signatures are BIP340 Schnorr by the member's Bitcoin key (same
-- key used for PSBT signing, x-only 32 bytes). Domain separation
-- tag is applied in the browser before hashing so a signature here
-- cannot be reused as a Bitcoin tx signature.
-- ============================================================

create table if not exists vault_attestations (
  id                 uuid primary key default gen_random_uuid(),
  vault_id           uuid not null references vaults(id) on delete cascade,
  user_id            uuid not null,
  attestation_type   text not null check (attestation_type in ('trust_doc','proof_of_life','death_declaration')),
  target_hash        text not null,
  target_data        jsonb not null default '{}'::jsonb,
  signature          text not null,
  pubkey             text not null,
  signed_at          timestamptz not null default now()
);

create index if not exists vault_attestations_vault_idx
  on vault_attestations(vault_id, attestation_type, signed_at desc);
create index if not exists vault_attestations_hash_idx
  on vault_attestations(vault_id, attestation_type, target_hash);

alter table vault_attestations enable row level security;

drop policy if exists "members_see_attestations" on vault_attestations;
create policy "members_see_attestations"
  on vault_attestations for select using (is_vault_member(vault_id));

alter publication supabase_realtime add table vault_attestations;
