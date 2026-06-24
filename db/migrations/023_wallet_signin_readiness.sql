-- ============================================================
-- 023_wallet_signin_readiness.sql
-- Tapit sign-in + green/red peer readiness.
--
-- Adds the data foundation for: signing into DynastyTrust by proving
-- control of a Tapit wallet key (linked to an existing account), the
-- visible "same wallet as last time" sign-in trail, and the peer-group
-- green/red readiness flag that gates LOGIN and IN-APP PARTICIPATION
-- only -- never a member's own base multisig spend.
--
-- Idempotent. Run in Supabase SQL Editor after 022_assistant.sql.
-- ============================================================

-- ------------------------------------------------------------
-- wallet_identities: one Tapit wallet bound to one DynastyTrust user.
-- Binding happens once, while already logged in, by proving key control
-- (sign-in flow). `pubkey` is the x-only Schnorr key the wallet proves.
-- `readiness` is the peer-group flag: 'green' (ready / uncompromised) or
-- 'red' (peer-flagged compromised). Red blocks login + in-app signing;
-- it does NOT touch the user's own multisig spend.
-- ------------------------------------------------------------
create table if not exists wallet_identities (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  pubkey               text not null unique,        -- x-only secp256k1, 64 hex
  bound_at             timestamptz not null default now(),

  readiness            text not null default 'green'
                         check (readiness in ('green', 'red')),
  readiness_reason     text,
  readiness_updated_at timestamptz not null default now(),
  readiness_updated_by uuid references auth.users(id) on delete set null
);

create index if not exists wallet_identities_pubkey_idx on wallet_identities(pubkey);

-- ------------------------------------------------------------
-- wallet_signin_challenges: server-minted, single-use TA-1 challenges,
-- stored by nonce so verifySignIn can check the returned proof against
-- the EXACT challenge we issued (the echo check is worthless otherwise).
-- The challenge is issued before we know which user will answer it; the
-- verify step resolves pubkey -> wallet_identities.user_id. Expired and
-- consumed rows are swept opportunistically.
-- ------------------------------------------------------------
create table if not exists wallet_signin_challenges (
  nonce         text primary key,                   -- 32-byte hex
  challenge      jsonb not null,                     -- the full SignInChallenge
  audience       text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  consumed_at    timestamptz                         -- set on first successful verify
);

create index if not exists wallet_signin_challenges_expires_idx
  on wallet_signin_challenges(expires_at);

-- ------------------------------------------------------------
-- wallet_signins: the append-only sign-in trail. Every verified login
-- writes one row, so the app can say "this is the same wallet that came
-- here last time" and a member can see their own login history. Not a
-- security boundary by itself -- a record that makes tampering visible.
-- ------------------------------------------------------------
create table if not exists wallet_signins (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  pubkey        text not null,
  audience      text not null,
  signed_at     timestamptz not null default now()
);

create index if not exists wallet_signins_user_id_idx on wallet_signins(user_id);

-- ------------------------------------------------------------
-- member_flags: the append-only green/red trail. A peer raises a 'flag'
-- (mark red) or 'clear' (back to green) on another member of a shared
-- vault, with a reason. The current readiness on wallet_identities is the
-- latest state; this table is the auditable history of who flagged whom
-- and why -- the "everyone can see the trail" the model leans on.
-- ------------------------------------------------------------
create table if not exists member_flags (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  vault_id        uuid references vaults(id) on delete set null,
  subject_user_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id   uuid not null references auth.users(id) on delete cascade,
  kind            text not null check (kind in ('flag', 'clear')),
  reason          text
);

create index if not exists member_flags_subject_idx on member_flags(subject_user_id);
create index if not exists member_flags_vault_idx    on member_flags(vault_id);

-- ------------------------------------------------------------
-- Row Level Security. Writes go through Netlify functions (service_role
-- bypasses RLS); these policies govern client READS only.
-- ------------------------------------------------------------
alter table wallet_identities        enable row level security;
alter table wallet_signin_challenges enable row level security;
alter table wallet_signins           enable row level security;
alter table member_flags             enable row level security;

-- A user sees their own wallet identity; co-members of a shared vault see
-- each other's readiness (so the peer group can see who is green/red).
drop policy if exists "wallet_identities_self_or_comember" on wallet_identities;
create policy "wallet_identities_self_or_comember"
  on wallet_identities for select
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from vault_members me
      join vault_members them on them.vault_id = me.vault_id
      where me.user_id = auth.uid()
        and me.status = 'active'
        and them.user_id = wallet_identities.user_id
    )
  );

-- Challenges are never read by the client (only the server verifies).
-- No select policy -> RLS denies all client reads by default.

-- A user sees their own sign-in trail.
drop policy if exists "wallet_signins_self" on wallet_signins;
create policy "wallet_signins_self"
  on wallet_signins for select
  using (user_id = auth.uid());

-- A member sees flags about themselves and flags on vaults they belong to.
drop policy if exists "member_flags_visible" on member_flags;
create policy "member_flags_visible"
  on member_flags for select
  using (
    subject_user_id = auth.uid()
    or actor_user_id = auth.uid()
    or (vault_id is not null and is_vault_member(vault_id))
  );

-- ------------------------------------------------------------
-- Helper: is this user's wallet currently red? Used server-side (and by
-- the login gate) to refuse login + in-app participation for a flagged
-- wallet. Returns false when the user has no bound wallet (binding is
-- optional; an unbound user just uses email login as before).
-- ------------------------------------------------------------
create or replace function wallet_is_red(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from wallet_identities wi
    where wi.user_id = target_user
      and wi.readiness = 'red'
  );
$$;
