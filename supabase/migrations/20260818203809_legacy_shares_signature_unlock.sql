-- ============================================================
-- legacy_shares_signature_unlock.sql
--
-- Adds a second, hardware-wallet-compatible way to unlock a Legacy
-- Recovery fast-path share (see apps/web/src/lib/legacy-recovery.ts's
-- signLegacyUnlockMessage / deriveLegacyLockBytesFromSignature). The
-- existing locked_fast_share_b64 column needs the raw mnemonic to
-- unlock -- fine for the vault-scoped setup flow, but impossible for a
-- hardware wallet, which never exports its private key at all.
--
-- identity_pubkey_hex: the PUBLIC identity child key (account xpub's
-- non-hardened /1/0 child -- see LEGACY_IDENTITY_PATH), computable by
-- anyone from just that role's xpub, no private key or mnemonic
-- involved. This is the lookup key for "here is my xpub, is there a
-- share hidden for it" -- indexed for that exact query.
--
-- locked_fast_share_sig_b64: the SAME plaintext fast-path share as
-- locked_fast_share_b64, locked instead with a value derived from a
-- deterministic ECDSA signature over a fixed message. Recovering this
-- copy needs only a signature, which is all a hardware wallet's "Sign
-- Message" feature ever produces -- the private key never leaves it.
--
-- Both columns are nullable: a share sealed before this migration, or
-- sealed for a key with no known derivationPath, simply has no
-- signature-based unlock option and still works exactly as before via
-- the mnemonic-based column. Nothing about the existing recovery path
-- changes.
-- ============================================================

alter table vault_legacy_shares
  add column if not exists identity_pubkey_hex text,
  add column if not exists locked_fast_share_sig_b64 text;

create index if not exists vault_legacy_shares_identity_pubkey_idx
  on vault_legacy_shares(identity_pubkey_hex)
  where identity_pubkey_hex is not null;
