-- ============================================================
-- 043_repair_ranged_descriptor_notation.sql
-- Data repair, not a schema change: fixes the TEXT of vaults.descriptor
-- for any vault compiled while netlify/functions/vaults-compile.js's
-- own upgradeDescriptor() still emitted the ranged `/0/*` wildcard
-- instead of the fixed `/0/0` child (2026-08-16, operator: real Gift
-- Locker vault descriptor pasted in and traced back to this bug).
--
-- Why this is safe to run directly, with no recompile and no funds
-- touched: `/0/*` (a range) and `/0/0` (its first, and this app's
-- only-ever-used, child) derive to the IDENTICAL key at index 0.
-- vaults.address was always built from the exact `/0/0` key baked
-- into the compiled leaf script -- the ranged notation never changed
-- which key actually signs, only which key EXTERNAL wallets (Sparrow,
-- Nunchuk) believed was available to derive from. This UPDATE touches
-- only the descriptor's TEXT so it stops advertising receive addresses
-- at index 1+ that this app's own compiler has no spending logic for
-- (see CLAUDE.md's "Fixed, non-ranged key-origin descriptor" entry).
-- address, founder_keys, heir_keys, key_origins, and every other
-- column are untouched.
--
-- `/0/*` only ever appears in this codebase as the suffix directly
-- after an xpub inside a `[fp/path]xpub/0/*` key-origin expression
-- (see upgradeDescriptor in both apps/web/src/lib/descriptor-keys.ts
-- and netlify/functions/vaults-compile.js) -- it cannot appear inside
-- a raw pubkey-hex key expression (e.g. a Tapit-origin key with no
-- BIP32 origin, which this repair correctly leaves untouched) or
-- anywhere else in a descriptor string, so a blanket substring
-- replace is exact with no false positives.
-- ============================================================

update vaults
set descriptor = replace(descriptor, '/0/*', '/0/0')
where descriptor like '%/0/*%';
