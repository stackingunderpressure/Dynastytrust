-- A signature records the signer's real role (operator, 2026-11-12:
-- "the roles of each person who joins the vault, the labeling and the
-- logging of their actions and their path into the vaults").
--
-- signer_sessions.signer_role was limited to 'founder' | 'heir', so a
-- protector, a beneficiary or the owner signing was written down as a
-- founder. It now takes every vault_members.role that may sign (a
-- viewer may not: see _authz.js canMutate).
--
-- Idempotent. Widens a check constraint only: every existing row
-- already satisfies the new one and keeps its old label -- a signature
-- recorded before today is not relabelled.

alter table signer_sessions
  drop constraint if exists signer_sessions_signer_role_check;

alter table signer_sessions
  add constraint signer_sessions_signer_role_check
  check (signer_role in ('owner', 'founder', 'heir', 'protector', 'beneficiary'));

comment on column signer_sessions.signer_role is
  'The signing member''s vault_members.role at the time they signed. Rows before 2026-11-12 hold only founder or heir.';
