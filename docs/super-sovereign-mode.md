# Super Sovereign Mode -- design sketch

Status: design note. Not implemented. Not time sensitive.

The goal is a single-download DynastyTrust that runs isolated on one
machine, talks only to services the user chooses, and can coordinate
multi-party vaults peer-to-peer without any hosted dependency.

This is the honest-end-state architecture. Ship it after the
cloud-hosted + self-host-docker modes are stable, not before.

---

## Goals

1. Download one artifact, double-click, works.
2. No outbound traffic the user did not authorize.
3. Every centralized dep of the cloud build has a sovereign swap:
   - Fly compiler         ->  rust-miniscript WASM in-process
   - Supabase DB          ->  local encrypted SQLite
   - Supabase Auth        ->  local secp256k1 keypair
   - Supabase Realtime    ->  Nostr relay(s) or direct onion peer
   - Netlify Functions    ->  embedded Express (bundled with app)
   - mempool.space        ->  user's Core RPC / electrs / mempool node
4. Tor-by-default for every outbound call, toggleable.
5. Zero telemetry. Hardcoded.

---

## Runtime shape

Tauri app is the best fit: Rust core + the existing React UI frozen
into a single binary. Ships a ~30 MB installer per platform
(.exe / .dmg / .AppImage / .deb). No node / docker / postgres install
needed on the user's machine.

Alternative: the docker compose bundle already planned is a fine
"power user" path. Tauri is the "mom and dad" path.

Build targets:
```
dynastytrust-windows-x64.exe
dynastytrust-macos-universal.dmg
dynastytrust-linux-x64.AppImage
dynastytrust.tar.gz             (source + docker compose)
```

Signed with a cold key, hash posted to the repo + IPFS pin of every
release.

---

## Component sketch

```
+---------------------------------------------------+
|  Tauri shell                                      |
|  +---------------------------------------------+  |
|  |  React UI (existing code, unchanged)        |  |
|  +----^----------+----------------^------------+  |
|       |          |                |               |
|   IPC bridge (serde JSON)         |               |
|       |          |                |               |
|  +----v----+  +--v---+       +----v----+          |
|  | local   |  |chain |       | sync    |          |
|  | store   |  |source|       |transport|          |
|  | (sqlite)|  |      |       |         |          |
|  +---------+  +------+       +---------+          |
|                   |                |               |
+-------------------+----------------+---------------+
                    |                |
        +-----------v------+   +-----v------------+
        | ChainSource impls|   | SyncTransport    |
        | -----------------|   | impls            |
        | 1 core-rpc       |   |------------------|
        | 2 electrs        |   | 1 nostr-relays   |
        | 3 mempool-local  |   | 2 onion-peer     |
        | 4 mempool-public |   | 3 file-exchange  |
        |    (Tor)         |   | 4 shared-relay   |
        +------------------+   +------------------+
                    |                |
                  (Tor)            (Tor)
```

Both ChainSource and SyncTransport are swappable at runtime. The UI
shows a "Sovereignty" settings panel:

- Chain source: [Core RPC @ localhost:8332]  [change...]
- Sync: [Nostr relays: wss://relay.damus.io, wss://nostr.mom]
- Tor: [enabled, routing all traffic]

---

## Data model

Single SQLite file, encrypted with SQLCipher using a passphrase
derived from the user's local keypair + a user-chosen password.

```
./dynastytrust.db            (encrypted)
./keys/                      (local identity + per-vault message keys)
./backups/                   (descriptor bundles, auto-written on save)
./logs/                      (local only; never shipped)
```

Schema is the existing Postgres schema cut down to what matters for
a single-user replica:
- vaults, vault_members, vault_invites
- proposals, signer_sessions
- vault_messages, vault_attestations
- vault_events
- event_log (NEW: append-only signed events for sync)

---

## Event model (Nostr-compatible)

Every state mutation is a signed event. The event is appended to
`event_log` locally and optionally published to Nostr relays for
peers. Peers replay the log to derive state. No CRDT gymnastics --
the event schema is small, and the Bitcoin-key signature gives
natural write authority (only a quorum of founders can sign events
that touch founder-only state).

Event kinds (borrowing Nostr NIP-01 structure):

```
kind=30001  vault_announce       (vault_id, descriptor_hash, network)
kind=30002  vault_member_upsert  (vault_id, member_pubkey, role, label)
kind=30003  trust_doc_update     (vault_id, new_doc_json, prev_hash)
kind=30004  proposal_created     (vault_id, path, dest, amount, psbt_hex)
kind=30005  signer_session       (proposal_id, fingerprint, partial_psbt)
kind=30006  attestation          (vault_id, type, target_hash, sig, pubkey)
kind=30007  message              (vault_id, ciphertext, nonce, recipients)
```

Each event:
```
{
  id: sha256(content),
  pubkey: member's Bitcoin x-only hex,
  kind: 30001..30007,
  created_at: unix,
  tags: [['e', vault_id], ['d', idempotency_key]],
  content: JSON payload,
  sig: schnorr sig by pubkey over id
}
```

Members publish to their chosen relays; other members subscribe.
Relays cannot forge -- signatures bind to known member pubkeys.
Relays can censor (drop events) -- mitigation is publishing to
multiple relays.

---

## Tor integration

Bundle `tor` as a sidecar process spawned by the Tauri shell. One
config:

```
SOCKSPort 127.0.0.1:9150
HiddenServiceDir /app-data/onion/
HiddenServicePort 8080 127.0.0.1:8080
```

The hidden service lets other members reach *this* instance directly
(onion-peer transport). The SOCKS port routes all outbound HTTP
through Tor.

Users see their onion address on the home screen; sharing it is how
peers find them for direct sync.

---

## Phased delivery (from the current cloud build)

Do not attempt all at once.

1. **Client-side compile.** Compile rust-miniscript to WASM, remove
   Fly.io dependency. One-day job. Unlocks offline compile.
2. **Docker compose self-host.** The stack I already sketched.
   Moves users off Supabase/Netlify without rewriting anything.
3. **Local identity** (local keypair auth, no email). Drops GoTrue
   from the dep list.
4. **Event log layer.** Add the `event_log` table + writer for every
   existing mutation. Backwards compatible: cloud build keeps
   working, but now every write is also a signed event.
5. **Nostr relay transport.** Wire event_log to publish/subscribe
   against user-configured relays.
6. **Tauri packaging.** Port the compose services into the Tauri
   shell. Embed SQLite, tor, the WASM compiler, and the Node
   function handlers.
7. **Onion peer transport.** Direct instance-to-instance sync over
   hidden services.
8. **Signed releases + IPFS pin.** So the binary itself is
   censorship-resistant.

Steps 1-3 are small and useful independently. Step 4 is the
architectural pivot. Steps 5-8 are the sovereign crown.

---

## Open questions

- Conflict resolution for concurrent edits of the trust doc.
  Probably: last-writer-wins by event timestamp, with attestations
  invalidated on any change. Good enough; trust doc edits are rare.
- Member discovery. Onion addresses need to be exchanged out-of-band
  the first time, then pinned. Nostr relay list could carry a
  "member_relays" event so peers bootstrap automatically.
- Relay spam / DoS. Mitigated by relay-side proof-of-work or paid
  relays. Not our problem to solve in code.
- Backups. The .db file + the ./keys directory is everything. Export
  to an encrypted .dynasty bundle, printable seed-equivalent QR for
  the local identity key.
- Update signing. We need a cold key to sign releases so supply
  chain compromise is detectable. Write the release signing key
  down in metal before the first binary ships.

---

## What this is NOT

- Not a replacement for the cloud build. Families that want easy
  onboarding get that path. This is for users who explicitly choose
  sovereignty.
- Not a new wallet. Bitcoin signing stays exactly as it is today
  (browser / HW signer, PSBT). This only replaces the coordination
  layer.
- Not a protocol. The event schema is ours; we are not trying to
  build an interop standard. If Nostr-compatible kinds let us
  piggy-back on existing relays, great; the events themselves are
  DynastyTrust-specific.
