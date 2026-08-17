-- ============================================================
-- 025_wallet_signin.sql
-- Tapit sign-in: link a wallet key to a DynastyTrust account and log in by
-- proving control of that key.
--
-- Green/red readiness is deliberately NOT here. The liveness ladder
-- (024_liveness_signals) is the single green/red model. This migration only
-- carries the wallet binding and the visible sign-in trail; it never gates a
-- spend and never touches a member's base multisig spend.
--
-- Idempotent. Run in Supabase SQL Editor after 024_liveness_signals.sql.
-- (NOTE: an earlier branch shipped a different 023_wallet_signin_readiness.sql
-- that also created wallet_identities/wallet_signins; if that was applied to a
-- project, these CREATE IF NOT EXISTS are no-ops and the readiness columns it
-- added are simply unused -- the liveness ladder is the green/red of record.)
-- ============================================================

-- wallet_identities: one Tapit wallet bound to one DynastyTrust user. Binding
-- happens once, while already logged in, by proving key control.
create table if not exists wallet_identities (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  pubkey     text not null unique,        -- x-only secp256k1, 64 hex
  bound_at   timestamptz not null default now()
);
create index if not exists wallet_identities_pubkey_idx on wallet_identities(pubkey);

-- wallet_signin_challenges: server-minted, single-use TA-1 challenges, stored
-- by nonce so verifySignIn checks the proof against the EXACT challenge issued.
create table if not exists wallet_signin_challenges (
  nonce       text primary key,
  challenge   jsonb not null,
  audience    text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);
create index if not exists wallet_signin_challenges_expires_idx
  on wallet_signin_challenges(expires_at);

-- wallet_signins: the append-only "same wallet as last time" trail.
create table if not exists wallet_signins (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references auth.users(id) on delete cascade,
  pubkey    text not null,
  audience  text not null,
  signed_at timestamptz not null default now()
);
create index if not exists wallet_signins_user_id_idx on wallet_signins(user_id);

-- RLS. Writes go through Netlify functions (service_role bypasses RLS); these
-- govern client READS only.
alter table wallet_identities        enable row level security;
alter table wallet_signin_challenges enable row level security;
alter table wallet_signins           enable row level security;

-- A user reads their own wallet binding.
drop policy if exists "wallet_identities_self" on wallet_identities;
create policy "wallet_identities_self"
  on wallet_identities for select
  using (user_id = auth.uid());

-- Challenges are never read by the client (no select policy -> RLS denies all).

-- A user reads their own sign-in trail.
drop policy if exists "wallet_signins_self" on wallet_signins;
create policy "wallet_signins_self"
  on wallet_signins for select
  using (user_id = auth.uid());
