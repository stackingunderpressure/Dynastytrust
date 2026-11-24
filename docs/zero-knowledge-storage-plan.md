# Zero-knowledge storage — scramble what the server keeps

Status: Z0 + Z1 slice 1 BUILT on claude/nostr-phase1-giftwrap (2026-11-24), not deployed. Decisions in section 8; build note in section 10.
Read from DynastyTrust origin/main @ 6d0b82d. Part of the Standard track in
tapit-wallet `docs/ROADMAP_STANDARD_SOVEREIGN.md` (P2, "privacy first").

## 1. Goal

Whoever runs or subpoenas the database gets random IDs, statuses, times and
ciphertext — never who people are, which vault holds what, where money goes,
or what anyone said. Keys stay where they are today: on members' devices.

## 2. What the server can read today

All 58 migrations applied; RLS on every table; the browser cannot write any
table (`20261113040000_no_client_writes.sql`), so every write passes through
a Netlify function with the service role. Readable by the operator today:

- **Vault structure** (`vaults`): name, address, descriptor, miniscript,
  every key and xpub, quorums, timelocks, leaves, key labels and origins,
  trust document, bloc policy, duress flag.
- **Money** (`proposals`, `signer_sessions`, `scheduled_stipends`,
  `distribution_wallets`, `vault_requests`): destinations, amounts, fees,
  memos, PSBTs, txids, recipient names, reasons, schedules.
- **People** (`vault_members`, `vault_invites`, `vault_membership_grants`,
  `circle_phrase_deliveries`, `wallet_identities`, `auth.users`): labels,
  xpubs, fingerprints, invited emails, account emails, Tapit pubkeys.
- **Words**: proposal comments and votes, the message `subject` (message
  bodies are already encrypted), assistant conversations.
- **History**: `vault_events.metadata` and the sealed `vault_ledger.payload`
  copy destinations, amounts, names, labels, subjects (event table in the
  inventory).
- **A bug, not a design choice:** `vault_membership_grants.reply_privkey` and
  `circle_phrase_deliveries.reply_privkey` store Nostr private keys in plain
  text.

Already encrypted: message bodies (`vault_messages`), the messaging-key backup,
sent secrets.

## 3. Why this is not a switch

The server does real work with that data:

| Job | Functions | Needs |
|---|---|---|
| Compile a vault | compile*, vaults-compile*, compile-leaves | keys, quorums, timelocks (sent to the Fly compiler) |
| Governance status and spend audit | governance, proposals | policy, path, amount, destination |
| Build a transaction | psbt-binary* | address, descriptor, keys, leaves, UTXOs |
| Check signatures, decide "fully signed" | signer-sessions, psbt-merge | PSBTs and the path's keys |
| Check a broadcast paid the right place | proposals (PATCH) | destination, amount, txid |
| PDFs and exports | vault-pdf, vault-audit-pdf, vault-tax-summary, vault-activity-export | everything |
| Wizard / Sage | assistant | vault facts, sent to Anthropic |
| Liveness check | liveness | bloc_policy circle keys |
| Invites | invites-lookup, invites-claim | vault name, paths, xpubs |

Some of those checks are protections, not conveniences (signature
verification, the broadcast check, the must-sign check). If the server can't
read the data, each member's device must run them before signing — the same
place Tapit already runs its own checks. That is the real cost of this plan.

## 4. The design

**A vault key.** When a vault is created, the founder's browser makes a
random 32-byte vault key. Vault data is encrypted with it (XChaCha20-Poly1305
or AES-256-GCM) before it is sent. The server stores ciphertext.

**Members get the vault key the way they already get messages.** Each member
already has an X25519 messaging key (`lib/messaging.ts`). The vault key is
wrapped to each member exactly like a message key is today (ECDH + HKDF +
AEAD), stored per member. A new member gets it wrapped by an existing member
when they join; nothing new to back up — the existing messaging-key backup
(passphrase-wrapped) brings it back on a new device.

**What stays readable, on purpose (routing):** row ids, vault id, member
user ids, roles, statuses, created/updated times, expiry. These let the
server route and enforce "members only". Hiding who is in which vault is a
later step (section 6, Z5).

**The ledger keeps working.** The hash chain and OpenTimestamps anchoring run
over whatever payload is stored; storing ciphertext keeps the chain
verifiable.

**Realtime keeps working.** Every subscriber ignores row contents and
re-fetches (`lib/realtime.ts`); ciphertext rows change nothing.

## 5. Honest limits

- **Losing every member's key loses the scrambled data.** If every member
  loses both their device and their messaging-key backup, nobody can read the
  vault's history. The money is not lost: keys are on members' devices and
  the descriptor is in Legacy Recovery on-chain.
- **Removing a member** stops them reading anything new (the vault key is
  replaced and re-wrapped to the remaining members), but they keep whatever
  they already saw.
- **mempool.space still sees addresses** whenever a balance is looked up;
  fixing that is Tor or an own node, not encryption.
- **Anthropic sees what the browser sends the assistant.** In zero-knowledge
  mode the browser decides what goes in the prompt and says so; Sovereign
  users can turn the assistant off.
- **The website itself** can still be made to serve a tampered app; only a
  signed download or native app closes that (roadmap P4, P5).

## 6. Phases — each ships alone, each reversible, cheapest first

**Z0 — fix the plain-text private keys.** Encrypt `reply_privkey` in both
tables under the user's own key (or drop them if the ack channel can derive
them). Small, and a real security fix.

**Z1 — words and labels the server never computes on.** Encrypt with the
vault key: proposal comments and votes, proposal memo, request reason,
recipient names and resolution notes, stipend and wallet names, message
subject (moved inside the ciphertext), key labels, vault name, trust
document (the server's fingerprint hash moves to the browser), sent-secret
labels and recipients; and the matching fields in event metadata and the
ledger payload. Invites stop storing the email (the invite link is the
secret; the inviter sends it however they like). Server functions only pass
ciphertext through.

**Z2 — money fields.** Destination, amount, fee, memo, txid, PSBTs. Move to
the browser: governance audit, building the PSBT (needs the compiler's PSBT
code in wasm — today only `descriptor_address` is exported), merging,
signature checks, and the broadcast check. Each signer's device verifies
before signing. PDFs and exports are generated in the browser (pdf-lib runs
there too).

**Z3 — vault structure.** Descriptor, address, keys, leaves, timelocks.
Compile entirely in the browser (the compiler crate to wasm), UTXO and fee
lookups straight from the browser (optionally over Tor). The server stores
one encrypted vault blob plus routing fields.

**Z4 — accounts without identity.** Username or Tapit-key accounts only
(both exist today); no real email; no password-reset email (recovery is the
key or passkey). Rate-limit buckets keep the IP only for their short window.

**Z5 — hide who shares a vault.** Members join under a per-vault pseudonym
instead of their account id. Hardest; last.

## 7. Tests before each phase is called done

- A schema check in CI: every column marked sensitive is ciphertext-typed;
  fails if a new plain sensitive column appears.
- A server test that saves and reads back a vault and asserts no plaintext
  name, address, amount or label appears anywhere in the stored rows or the
  ledger.
- Round trip on two devices: founder creates, member joins and reads.
- Member removal: the new vault key is unreadable to the removed member.
- Every protection moved to the device (signature check, broadcast check,
  must-sign) has a test that it still refuses a bad PSBT.
- Signet: create, fund and spend a vault on every path with Z2/Z3 on.

## 8. Decisions (operator, 2026-11-24)

1. Start with Z0 + Z1.
2. Safety checks move to each member's device in Z2; the server becomes a relay.
3. Assistant in scrambled mode: the browser shows what it will send; the person approves.
4. Invites stop storing the invited person's email.
5. Build on `claude/nostr-phase1-giftwrap` (stacked on Phase 1).

## 9. Left out

Hiding IP addresses (Tor), self-hosting the database, the Nostr-only
Sovereign coordination path, and the vault-key separation work
(tapit-wallet `docs/VAULT_KEY_SEPARATION_PLAN.md`).

## 10. Build note for Z0 + Z1 (read from the code on claude/nostr-phase1-giftwrap)

### Z0 re-rated after reading the code

`reply_privkey` (vault_membership_grants, circle_phrase_deliveries) is a
separate key from the one that encrypts the invite or the phrase
(`circle-membership-delivery.ts:194-195`, `circle-phrase-delivery.ts:83-84`).
A leaked reply key decrypts only the acknowledgement ("accepted / declined /
received"), which the server already stores as `status`; membership acks
cannot be forged with it, because the sender must be the member's own key
(`VaultMembershipSetup.tsx:225,261`). So Z0 is hygiene, not a hole. It still
belongs in zero-knowledge (the server should hold no decryption keys): the
reply private key gets wrapped to the owner's own messaging key.

Found nearby, a real small gap: circle-phrase "received" acks are NOT checked
against the recipient's key (`circle-phrase-ack-channel.ts` returns only the
reply pubkey), and the reply pubkey is public in the request event, so anyone
who saw the request could post a fake "received". Fix: check the ack's
signer against the recipient's Tapit key, as membership acks already do.

### The vault key's trust anchor

The vault key is wrapped to each member's `vault_members.messaging_pubkey`,
which the server stores. A server that swapped a member's messaging key
could wrap the vault key to itself. DynastyTrust already defends messages
against exactly this with safety codes and key pins (`lib/messaging-safety.ts`);
the vault key uses the same pins, so it inherits that protection and its
limit: a first-ever key is trusted on first use unless members compare
safety codes.

### Consequences a person will notice

- A new member sees names, comments and labels only after an existing
  member's app has opened the vault and wrapped the key for them (happens
  automatically on the next open). Until then: "Waiting for a member to share
  the vault key with you."
- The invite page cannot show the vault's name from the server; the name rides
  in the invite link itself (after the `#`, never sent to the server).
- PDFs and exports read names, comments and labels, so they must be built in
  the browser for these fields (pdf-lib runs there).
- Old rows: existing readable values are re-encrypted by the owner's app on
  next open, then the readable column is cleared. The history ledger is
  append-only and hash-chained (`_vault_ledger.sql:64-72`), so entries already
  written stay readable; only new entries are scrambled. With no real users
  yet, the alternative is a clean reset of test data (decision 6).

### Blast radius, per field

| Field | Written by | Read by |
|---|---|---|
| proposal_comments.body, .vote | proposal-comments.js | ProposalDetail.tsx; vault-audit-pdf, vault-tax-summary, vault-activity-export |
| proposals.memo | proposals.js | ProposalDetail, tax summary, exports |
| vault_requests.reason, recipient_name, resolution_note, rule_name | vault-requests.js | VaultDetail requests tab, audit PDF, ledger payload |
| scheduled_stipends.name, recipient_name | stipends.js | VaultDetail, audit PDF, ledger |
| distribution_wallets.name, beneficiary_name | distribution-wallets.js | VaultDetail, audit PDF, ledger |
| vault_messages.subject | vault-messages.js | VaultDetail messages, ledger (message_sent) |
| vaults.name | vaults.js, compile* | everywhere a vault is listed; invites-lookup; PDFs; assistant prompt |
| vaults.key_labels, vault_members.label / key_label | vaults.js, members.js, invites-claim.js | VaultDetail roster, PDFs, ledger |
| vaults.trust_doc | vaults.js (hashes it at :10) | TrustTab, audit PDF, vault_attestations.target_data |
| sent_secrets.label, recipients | sent-secrets.js | sent secrets list |
| vault_invites.invited_email, invited_label | invites.js | invites-lookup (masked email), InviteClaim |
| vault_events.metadata, vault_ledger.payload | `_ledger.recordEvent` from ~15 functions | timeline, ledger verify, exports |
| assistant_messages.content, threads.checklist | assistant.js | assistant UI; the prompt history sent to Anthropic |
| reply_privkey (Z0) | vault-membership-grants.js, circle-phrase-deliveries.js | VaultMembershipSetup, CirclePhraseSetup |

Unchanged by Z1: anything the server computes on for money or structure
(address, descriptor, keys, quorums, timelocks, amounts, destinations, PSBTs)
— that is Z2/Z3.

### Slices (each ships alone)

1. **Vault key + one field end to end.** Key made at vault creation, wrapped
   to members, re-wrapped for new members on open, replaced on member
   removal; proposal comments and the message subject encrypted; the "waiting
   for the key" state. Z0 reply keys wrapped to the owner. Circle-phrase ack
   signer check.
2. **Names and labels** (vault, members, keys, requests, stipends, wallets,
   sent secrets) + invite name in the link fragment + invites without email.
3. **History payloads** (event metadata, ledger) for new entries.
4. **PDFs and exports in the browser.**
5. **Assistant**: history kept and sent from the browser; shows what goes to
   the AI and asks.

### Z1 status (2026-11-24): all five slices built, not deployed

1. Vault key, sealed comments and votes, Z0, phrase-ack check -- done.
2. Names and labels, invite name in the link, invites without email -- done.
   Shared seal/open in `lib/api.ts` via `lib/vault-keyring.ts` and
   `lib/sealed-fields.ts`.
3. History: entries already copy names sealed after slice 2; the activity
   log and ledger page open them for display only -- done.
4. Reports built on the device from one sealed export
   (`lib/reports/`); the server PDF functions are gone -- done.
5. Sage: stateless relay, nothing stored, one-time consent -- done.

Still readable on the server after Z1, by design of the phases: money
fields (amounts, destinations, fees, txids, PSBTs -- Z2), vault structure
and path labels (Z3), account identity and the `terms_accepted` user agent
(Z4), who shares a vault (Z5). Proof is by tests (`test-api-sealing.mjs`
fails if a plain name is ever sent); NOT yet walked in a browser with two
real accounts.

### Decisions still needed

6. Existing test data: RESET (operator, 2026-11-24) -- by hand with
   `scripts/reset-test-data.sql` at ship time, never inside a migration.
7. A new member waiting for the key: accepted (operator, 2026-11-24).
