# Build note: ranged addresses, slice 2 -- database and address issuing

Status: plan for the operator's OK. Nothing below is built yet.
Base: working branch `claude/dynasty-unify-2026-11` @ `1d7d993` (slice 1, the
Rust core in `protocol/src/ranged.rs`, Core-checked vectors). Parent plan:
the operator's `dynastytrust-ranged-addresses-build-note.md` (sections 5 and 7).

## The ask, in the operator's words

> "I'd proceed with the database migration and address-issuing function, but
> I would want the plan to explicitly cover: preserving existing v1 vaults and
> addresses; storing the v2 derivation version; tracking receive and change
> indexes independently; preventing duplicate address issuance under
> concurrent requests; ensuring an issued address can always be reproduced
> from the compiled vault; handling migration rollback and interrupted
> migrations; never silently changing a vault's descriptor or key paths."

## What gets built

One additive migration, one server function that hands out the next address
of a v2 vault, and the Rust-to-WebAssembly export it derives with. No screen,
no compile path for v2 vaults, no scanning, no spending -- those are later
slices. Until the compile slice ships, no real vault can be v2, so nothing
here changes what any user sees.

## What is true today (read from the code, 2026-11-19)

- Migrations: `supabase/migrations/*.sql`, applied on every push to main by
  `.github/workflows/supabase-db-deploy.yml` -> `scripts/supabase-migrate.sh`.
  The runner wraps EACH file in `BEGIN ... COMMIT` together with its own
  tracking row; a failure rolls back the whole file and the row is never
  written, so it is retried on the next push.
- Since `20261113040000_no_client_writes.sql` the browser cannot insert,
  update or delete anything; every write goes through a Netlify function with
  the service-role key.
- Nothing in the database stops a compiled vault's descriptor or keys from
  changing -- only server code does. The one current path that rewrites key
  data on a compiled vault is the owner's `key_origins` repair in
  `netlify/functions/vaults.js` (~line 440): leaf-list vaults only, and it
  overwrites existing values, not just empty ones.
- Precedent for touching descriptor text: `20260816194321_repair_ranged_descriptor_notation.sql`
  rewrote `/0/*` to `/0/0` in place. Exactly the kind of change this plan
  makes impossible to do quietly.
- Postgres 16 is available in this sandbox, so the migration, the lock and
  the concurrency test run against a real database before anything ships.

## 1. Preserving existing v1 vaults and addresses

- The migration is additive only: new columns with defaults, two new tables,
  two functions, one trigger. No `UPDATE`, `DELETE`, rename or drop of any
  existing column or row. A test fails if the file ever contains a
  data-changing statement against `vaults`.
- Every existing row becomes `descriptor_version = 1` through the column
  default -- not by an UPDATE -- and v1 code reads none of the new columns.
- `vaults.address` keeps its meaning for both versions; for v2 it is
  receive/0, which slice 1 proved equals the compiled v1 address.
- The issuing function refuses a v1 vault outright ("this vault has one fixed
  address"); it never derives anything for one.

## 2. Storing the v2 derivation version

On `vaults`:
- `descriptor_version smallint not null default 1 check (descriptor_version in (1, 2))`
- `descriptor_multipath text`, `descriptor_receive text`, `descriptor_change text`
  -- the `<0;1>/*` descriptor and its two halves, with checksums, exactly as
  `RangedVault` writes them.
- A check constraint: version 1 has all three NULL; version 2 has all three
  set. A v2 row without its descriptors cannot exist.
- `ranged_format smallint` -- which derivation rule made the descriptors
  (1 = slice 1's `RangedVault`), so a later rule change can never be
  mistaken for the one that issued old addresses. Required when version is 2.

## 3. Receive and change indexes, independently

A separate table, not columns on `vaults`:

```
vault_address_branches(
  vault_id uuid references vaults(id) on delete cascade,
  branch smallint check (branch in (0, 1)),      -- 0 receive, 1 change
  next_index integer not null default 0 check (next_index between 0 and 2147483648),
  primary key (vault_id, branch))
```

Two rows per v2 vault. A receive issue locks only the receive row, so the
branches never wait on each other, and issuing never writes to the `vaults`
row -- which stays frozen (point 7).

```
vault_addresses(
  vault_id, branch, idx,                          -- primary key
  address text not null unique,
  script_pubkey text not null,
  descriptor_checksum text not null,              -- checksum of the branch descriptor that derived it
  issued_at timestamptz not null default now(),
  issued_by uuid,                                 -- the signed-in user who asked
  label text)
```

## 4. No duplicate issuance under concurrent requests

Two layers, each sufficient alone:

1. Reserving an index is one statement in a `security definer` function:
   `update vault_address_branches set next_index = next_index + 1 where vault_id = $1 and branch = $2 returning next_index - 1`.
   Postgres row-locks the row, so concurrent callers each get a different
   index, in order.
2. `primary key (vault_id, branch, idx)` and `unique (address)` make a second
   row for the same index or address impossible even if layer 1 had a bug.

An index reserved but never recorded (the function dies between the two
steps) is burned, never reused; it only counts toward the gap. The RPC is
`revoke`d from `anon` and `authenticated` and granted to `service_role` only.

Proof before shipping: a script fires 50 simultaneous issue requests at the
real function on local Postgres 16, then checks 50 distinct indexes, 50
distinct addresses, and counter = 50.

## 5. An issued address can always be reproduced from the compiled vault

- The server derives with the same Rust (`RangedVault`), compiled to
  WebAssembly and run inside the function -- no JavaScript derivation, and no
  dependence on the Fly compiler being awake.
- Before recording an address, the function rebuilds `RangedVault` from the
  STORED `descriptor_multipath`, derives the index, and checks it against the
  stored `descriptor_receive`/`descriptor_change` derivation too. Any
  disagreement refuses the issue; nothing is written.
- Each address row records the checksum of the descriptor that made it. A
  database check refuses an address row whose checksum is not the vault's
  current branch descriptor checksum.
- A test re-derives every stored address from the vault's descriptor and must
  match, and the WebAssembly export is held to slice 1's Core-checked vectors.
- Later (screens slice): the browser re-derives every shown address itself
  and refuses to display a mismatch.

## 6. Rollback and interrupted migrations

- Interrupted: the runner's per-file transaction means a migration is either
  fully applied with its tracking row, or not at all; the next push retries
  it. The file is also idempotent (`if not exists`, `create or replace`,
  `drop trigger if exists`), so a manual re-run is harmless.
- Rollback of code: everything new sits behind `descriptor_version = 2`, which
  no vault can have until the compile slice. Reverting this slice's code
  leaves an unused but harmless schema.
- Rollback of the schema: `supabase/rollbacks/<same stamp>_ranged_addresses_down.sql`,
  outside `migrations/` so it never runs by itself. It removes the trigger,
  functions and tables, then the columns -- but first raises an error and
  changes nothing if any vault is version 2 or any address was issued.
  Issued addresses may hold coins; their record is never discarded silently.
- Deploy order: the database job and the Netlify build start from the same
  push. If the function is live before the columns exist, it fails with a
  clear error and no write -- and nothing calls it yet.
- Tested on local Postgres 16: apply, apply again (no-op), roll back, roll
  back refused once an address exists, and a mid-file failure leaving no
  partial schema.

## 7. Never silently changing a vault's descriptor or key paths

A database trigger on `vaults`, `BEFORE UPDATE`: once a vault is no longer a
draft, any change to `address`, `descriptor`, `descriptor_version`,
`descriptor_multipath`, `descriptor_receive`, `descriptor_change`,
`ranged_format`, `leaves`, `leaf_scripts`, `founder_keys`, `heir_keys`,
`backup_keys`, `second_heir_keys`, `consent_keys`, or `bloc_policy` raises an
error. That holds for the server's service-role key too -- not just for
browsers.

- `key_origins` (the key paths a hardware wallet signs with) may go from empty
  to filled once -- the existing repair -- but never from one non-empty value
  to another. `vaults.js`'s repair is changed to refuse the same, so the
  owner sees a sentence, not a database error. (Decision below.)
- A v1 vault can never become v2, and a v2 vault never changes its
  descriptors: the issuing function only ever writes the two new tables.
- A deliberate repair like `20260816194321` would need a migration that
  disables this trigger by name, in a file a reviewer can see -- never a
  quiet `UPDATE`.
- Before the trigger ships, every current writer is checked against it:
  the three compile routes (draft -> compiled, allowed), `vaults.js` PATCH
  (name, archived, trust_doc, duress, key_labels -- not frozen; network and
  leaves only while draft), the key_origins repair (above). `npm test` and
  the offline harness must stay green with the trigger in place on local
  Postgres.

## Blast radius

- New: one migration, one rollback file, `netlify/functions/vault-addresses.js`
  (POST: issue the next receive address for a v2 vault the caller owns or is
  a member of), a WebAssembly export of the ranged derivation, tests.
- Changed: `vaults.js` key_origins repair (refuses overwriting non-empty);
  `_vault-fields.js` (the new columns, so every route returns them);
  `protocol-wasm` / `compiler-wasm` rebuilt and their manifests.
- Unchanged: every v1 read and write path, `vaults.address`, balances,
  PSBTs, the PDF and ledger, the download build.
- Live database: the migration runs automatically on the next push to main,
  and only then. Shipping waits for your word, as always.

## Deliberately left out

- Creating v2 vaults (the compile path and the wizard toggle) -- slice 3.
  Until then this slice is exercised by tests on local Postgres, not by users.
- Change-index reservation by the spend builder (same function, `branch = 1`)
  -- arrives with the spend slice; the table and function already allow it.
- Scanning, balances, spending, the backup format, the screens, Sage's facts
  about v2, and the CLAUDE.md "single fixed address" rule -- each later.
- A gap-limit warning: needs "used" information from scanning, so it comes
  with the scanning slice.
