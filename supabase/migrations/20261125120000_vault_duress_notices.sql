-- ============================================================
-- 20261125120000_vault_duress_notices.sql
-- A wellness checker's duress phrase stops the whole circle
-- (docs/wellness-group-build-note.md, slice 2; operator, 2026-11-25:
-- clearing takes the owner AND the circle's quorum; the notice goes
-- straight to the server).
--
-- One row per signed notice a vault member's Tapit sends to
-- /api/vault-duress ('raise' or 'clear'), plus the owner's own clear
-- request ('owner_clear', from a signed-in session). The function decides
-- from these rows when a hold lifts. Rows are written only by that
-- function (service role); never edited; the owner and active members may
-- read their vault's rows.
--
-- Additive only: a new table. No existing row changes.
-- ============================================================

create table if not exists vault_duress_notices (
  id             uuid primary key default gen_random_uuid(),
  vault_id       uuid not null references vaults(id) on delete cascade,
  kind           text not null check (kind in ('raise', 'clear', 'owner_clear')),
  -- x-only hex of the Tapit key that signed it; null for owner_clear.
  signer_pubkey  text check (signer_pubkey is null or signer_pubkey ~ '^[0-9a-f]{64}$'),
  -- The notice's Schnorr signature: unique, so a notice can be used once.
  sig            text unique check (sig is null or sig ~ '^[0-9a-f]{128}$'),
  signed_at      timestamptz,
  created_at     timestamptz not null default now(),
  check ((kind = 'owner_clear') = (signer_pubkey is null))
);

create index if not exists vault_duress_notices_vault_idx on vault_duress_notices(vault_id, created_at);

alter table vault_duress_notices enable row level security;

drop policy if exists "members_read_duress_notices" on vault_duress_notices;
create policy "members_read_duress_notices" on vault_duress_notices
  for select to authenticated
  using (
    exists (select 1 from vaults v where v.id = vault_id and v.user_id = auth.uid())
    or exists (select 1 from vault_members m where m.vault_id = vault_duress_notices.vault_id and m.user_id = auth.uid() and m.status = 'active')
  );

revoke insert, update, delete on vault_duress_notices from anon, authenticated;
