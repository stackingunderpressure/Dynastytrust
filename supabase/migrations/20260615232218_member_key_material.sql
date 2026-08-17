-- ============================================================
-- 007_member_key_material.sql
-- Each vault member now stores the compressed pubkey hex and the
-- derivation path alongside their xpub. Together with the existing
-- fingerprint, these are everything the server needs to compile a
-- draft vault into a Nunchuk-format descriptor without re-asking
-- each member for their key material.
-- ============================================================

alter table vault_members
  add column if not exists pubkey text,
  add column if not exists derivation_path text;
