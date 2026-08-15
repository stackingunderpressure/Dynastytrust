-- ============================================================
-- 040_vault_membership_grant_left_status.sql
-- Widen vault_membership_grants.status to accept 'left' (2026-08-15,
-- operator: "say you want to disengage from it and you want to delete
-- yourself from it, then it would notify Dynasty Trust that you have a
-- trustee that's disconnected"). A member's Tapit wallet can now walk
-- back an earlier 'accepted' by publishing a 'left' ack over the same
-- vault-membership-ack Nostr channel (kind 9580) it used to accept --
-- distinct from 'declined' (never accepted in the first place). This is
-- a soft disconnect only: it changes what the apps show and offer, not
-- the on-chain policy -- the member's key stays a valid signer in the
-- compiled Taproot script until the vault is actually recompiled without
-- them. See VaultMembershipSetup.tsx's STATUS_LABEL for the disclosure
-- shown alongside the 'left' status.
-- ============================================================

alter table vault_membership_grants
  drop constraint if exists vault_membership_grants_status_check;

alter table vault_membership_grants
  add constraint vault_membership_grants_status_check
  check (status in ('sent', 'accepted', 'declined', 'left'));
