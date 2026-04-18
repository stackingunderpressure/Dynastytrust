-- ============================================================
-- 012_protector_path.sql
-- Fourth Taproot leaf for a trust protector. In real-world trust
-- law a "protector" is an independent party who can step in if
-- the primary trustees go bad -- they can't spend day-to-day, but
-- after a medium-length timelock they gain a spend path that
-- lets them move funds to a fresh vault with new trustees.
--
-- Without this, the only way to remove a rogue co-trustee on a
-- compiled vault is the full inheritance timelock (typically 1+
-- year). That's too long. Protector path typically sits at 3-9
-- months -- long enough that a bad-faith protector trigger is
-- visible, short enough to actually rescue funds.
-- ============================================================

alter table vaults
  add column if not exists protector_keys     jsonb not null default '[]'::jsonb,
  add column if not exists protector_quorum   integer,
  add column if not exists protector_after    integer;

-- Extend the vault_members role enum to include 'protector'.
alter table vault_members drop constraint if exists vault_members_role_check;
alter table vault_members
  add constraint vault_members_role_check
  check (role in ('owner', 'founder', 'heir', 'protector', 'viewer', 'beneficiary'));

alter table vault_invites drop constraint if exists vault_invites_invited_role_check;
alter table vault_invites
  add constraint vault_invites_invited_role_check
  check (invited_role in ('founder', 'heir', 'protector', 'viewer', 'beneficiary'));
