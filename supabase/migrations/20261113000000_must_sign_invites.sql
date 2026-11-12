-- Must-sign invites (operator, 2026-11-12: build "must-sign invites").
--
-- A path in a path-builder vault has two groups of keys: the keys that
-- must EACH sign every spend on it (leaves[].required_keys) and the
-- ordinary k-of-n group (leaves[].keys). Until now an invite could only
-- fill the ordinary group; the owner had to hold every must-sign key
-- themselves. These columns record that an invite, and the member it
-- creates, are for the must-sign group, so the person's confirmed key
-- lands in the right group.
--
-- Idempotent. Adds columns only, default false: every existing invite
-- and member keeps meaning exactly what it meant (the ordinary group).

alter table vault_invites
  add column if not exists must_sign boolean not null default false;

alter table vault_members
  add column if not exists must_sign boolean not null default false;

comment on column vault_invites.must_sign is
  'Path-builder vaults: true when this invite fills a must-sign slot on leaf_id (a key every spend on that path needs), false for the ordinary group.';
comment on column vault_members.must_sign is
  'Path-builder vaults: true when this member was invited to hold a must-sign key on leaf_id.';
