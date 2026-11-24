-- ============================================================
-- 20261124210000_grant_review_mode.sql
-- What a Tapit co-signer sees, chosen per member (operator, 2026-11-24:
-- "option for a vault builder to choose blind transactions and only need
-- the wellness check part of relationship. Both options available";
-- docs/tapit-review-modes-build-note.md, decisions: per member, remembered
-- here, next 200 change addresses).
--
--   review_mode   'wellness' -- the member confirms the PERSON (today's
--                 behaviour, the default for every existing row);
--                 'full'     -- the member also sees the money: what leaves
--                 the vault, to where, and the change coming back.
--   change_until  the change-address index the request's signed list runs
--                 up to (exclusive); the Members tab warns before the vault
--                 reaches it. Null for a one-address vault and for rows sent
--                 before this.
--
-- Additive only: two nullable/defaulted columns, no existing value changed.
-- ============================================================

alter table vault_membership_grants
  add column if not exists review_mode text not null default 'wellness';

alter table vault_membership_grants
  drop constraint if exists vault_membership_grants_review_mode_check;

alter table vault_membership_grants
  add constraint vault_membership_grants_review_mode_check
  check (review_mode in ('wellness', 'full'));

alter table vault_membership_grants
  add column if not exists change_until integer
  check (change_until is null or change_until >= 0);
