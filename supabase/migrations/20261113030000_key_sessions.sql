-- ============================================================
-- Email-free sign-in, slice 3 (docs/key-signin-build-note.md).
-- Operator's chip, 2026-11-13: "Key sign-in is enough" to join a
-- real-bitcoin vault. A Supabase session cannot show how it was made (a
-- key sign-in and an email code both read aal1 / amr otp -- proven live),
-- so the server records it itself:
--   key_session_claims: a one-time claim handed out ONLY with a login
--     token that a key proof earned (key-signup.js, wallet-signin-verify.js);
--     stored hashed, single-use, 10 minutes.
--   key_sessions: the session ids (from the verified JWT) that redeemed a
--     claim for the same account (key-session.js). invites-claim.js reads it.
-- Server-only: RLS on, no policies, so no browser can read or write them.
-- Idempotent.
-- ============================================================

create table if not exists key_session_claims (
  claim_hash  text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index if not exists key_session_claims_expires_idx on key_session_claims(expires_at);

create table if not exists key_sessions (
  session_id  uuid primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists key_sessions_user_idx on key_sessions(user_id);

alter table key_session_claims enable row level security;
alter table key_sessions       enable row level security;

notify pgrst, 'reload schema';
