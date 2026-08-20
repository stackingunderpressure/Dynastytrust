/**
 * circle-membership-delivery.ts -- Cut C3 (docs/build-map-and-cut-lists.md
 * risk register, "no rogue signing"): DynastyTrust mints the vault-membership
 * ATTESTATION REQUEST for a Tapit circle member and delivers it over Nostr.
 *
 * This does NOT produce a signed Attestation -- DynastyTrust has no Tapit
 * identity or private key to sign as. It sends the plain claim fields
 * (which vault, which role, which exact tapscript leaf bytes that member's
 * key appears in) to the member's Tapit wallet; the wallet reviews them and
 * self-mints + self-signs the attestation via wallet.attest(), which is what
 * satisfies vaultTrail.ts's findVaultTrail (Tapit repo) -- that check
 * requires the WALLET's own signature on the held attestation, not merely a
 * signature from whoever asked it to hold something. A bare envelope push
 * of a DynastyTrust-signed claim could never pass that check, which is why
 * this is a request-and-review flow (its own Nostr kind, mirroring the
 * psbt-cosign request channel) rather than a ride on the envelope inbox
 * (kind 9573, TAPIT_ENVELOPE_KIND) used for already-signed attestations.
 *
 * Mirrors tapit-nostr-cosign.ts / circle-phrase-delivery.ts's send pattern
 * exactly: an EPHEMERAL per-delivery keypair as the Nostr sender identity,
 * NIP-44 encrypt to the recipient's real Tapit x-only pubkey, durable
 * outbox enqueue before any network attempt, best-effort immediate publish.
 *
 * 2026-08-11 follow-up (operator: "we need to have a return roster of
 * it... a verified member that's signed it"): the request now also
 * names a `response_channel` -- a SECOND ephemeral keypair, distinct
 * from the sender identity above, whose public half Tapit's
 * acceptVaultMembership/decline flow addresses its ack to (kind 9580,
 * vault-membership-ack-channel.ts). Unlike tapit-nostr-cosign.ts's reply
 * key (kept in memory only, for one signing session), this one is
 * PERSISTED by the caller (VaultMembershipSetup.tsx, via
 * api.vaultMembershipGrants.create) -- a membership grant can sit
 * unanswered for hours or days, long after the tab that sent it is
 * closed, so the key that will eventually decrypt the ack has to
 * outlive this call entirely.
 */

import { schnorr } from '@noble/curves/secp256k1';
import { buildEvent, NostrTransport } from '@dynastytrust/nostr-transport';
import { encryptTo } from '@dynastytrust/nip44';
import { DEFAULT_RELAYS } from './tapit-nostr-cosign';
import { nostrOutbox } from './nostrOutbox';

// Next free sibling after the circle-phrase channel's 9577.
export const VAULT_MEMBERSHIP_REQUEST_KIND = 9578;

/** The vault-membership role a signer's key appears under. Matches the
 *  leaf names the Fly.io compiler returns (compiler/src/main.rs's
 *  CompileResponse.leaf_scripts) and the roles vaults-compile.js already
 *  sorts founders/heirs/backup/consent keys into. Every one of a vault's
 *  key slots (founder, heir, backup, consent) can be a Tapit key --
 *  2026-08-11 fix: this used to be founder-only by construction
 *  (VaultMembershipSetup only ever looked at founder_keys), which
 *  silently refused to send a membership request to a Tapit key sitting
 *  in any other role. There is nothing role-specific about Tapit's
 *  receiving side -- vaultTrail.ts's role field is a bare string, never
 *  validated against a fixed set -- so the restriction was only ever on
 *  this sending side.
 *
 *  2026-08-19 widened again for the generic leaf-list ("custom builder")
 *  vault shape: that shape has no fixed role vocabulary at all, only
 *  whatever leaf ids the owner named when building it. `(string & {})`
 *  keeps autocomplete/literal-checking for the five named-field roles
 *  above while still accepting an arbitrary leaf id as a valid role --
 *  see `leafScriptsForRole`'s fallback branch below for how an unknown
 *  role is resolved. */
export type VaultMembershipRole = 'founder' | 'heir' | 'backup' | 'consent' | 'second_heir' | (string & {});

/** The leaf names (compiler/src/main.rs's CompileResponse.leaf_scripts
 *  keys) a given role's key is a legitimate signer on. A founder signs
 *  both the immediate founders_now leaf AND the timelocked recovery leaf
 *  (recovery spends via the founders' own keys, just after a delay) --
 *  see policy_compiler.rs's MultileafOutput doc comment. Heirs have
 *  exactly one leaf of their own. Backup keys are a SEPARATE key set from
 *  founders (never reused) that occupies the same tree slot recovery
 *  would otherwise use, mutually exclusive with it -- the compiler's
 *  leaf_scripts map only ever has one of "recovery" or "backup" present
 *  for a given vault, never both, so listing "backup" under founder here
 *  would be wrong (founder keys are never IN the backup leaf) and is
 *  correctly kept as its own role instead. Consent keys are compiled
 *  directly INTO the founders_now leaf script itself (policy_compiler.rs
 *  ANDs the founder threshold with the consent threshold into one
 *  miniscript) -- there is no separate "consent" leaf to point at, so a
 *  consent key's real leaf is founders_now. Second-inheritance keys
 *  (2026-08-11) are an independent heir cohort with their own leaf, named
 *  "second_inheritance" in the compiler's leaf_scripts map -- see
 *  MultileafOutput's second_inheritance_leaf.
 */
const LEAVES_FOR_ROLE: Record<VaultMembershipRole, readonly string[]> = {
  founder: ['founders_now', 'recovery'],
  heir: ['inheritance'],
  backup: ['backup'],
  consent: ['founders_now'],
  second_heir: ['second_inheritance'],
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateEphemeralKeypair(): { privateKey: string; publicKey: string } {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const privateKey = toHex(priv);
  const publicKey = toHex(schnorr.getPublicKey(priv));
  return { privateKey, publicKey };
}

/** Wire payload -- deliberately NOT the tapit-attest SignRequest shape
 *  (intent 'attest'), which carries a `callback` URL for a deeplink
 *  redirect that makes no sense for a request arriving unsolicited over
 *  Nostr while the wallet is already open. Tapit's receiving side builds
 *  its own review + wallet.attest() call from these fields directly. */
export interface VaultMembershipRequestPayload {
  v: 1;
  vault_descriptor: string;
  vault_name: string;
  role: VaultMembershipRole;
  /** Hex-encoded tapscript leaf bytes this signer's key is known to
   *  appear in -- JSON-stringified array, matching the shape
   *  vaultTrail.ts's readVaultMembership expects in the `leaf_scripts`
   *  claim field. */
  leaf_scripts: string[];
  /** Decimal sats string; absent means "always require the callback"
   *  (vaultTrail.ts's requiresCallbackConfirmation fail-closed default). */
  high_value_threshold_sats?: string;
  /** Where Tapit should publish its accept/decline acknowledgment.
   *  Optional for backward compatibility with already-sent requests that
   *  predate this field -- Tapit's schema validator treats its absence
   *  as "no ack channel available," not a malformed request. */
  response_channel?: { kind: 'nostr'; requester_pubkey: string };
}

export interface SendVaultMembershipResult {
  eventId: string;
  /** True when a relay confirmed receipt before this call returned. False
   *  means the event is safely queued in the durable outbox -- see
   *  nostrOutbox.ts's header for exactly what "durable" means here. */
  delivered: boolean;
  /** This request's ack-channel reply keypair (see this file's header).
   *  The caller persists `replyPrivateKey` (api.vaultMembershipGrants.create)
   *  -- it is NOT a Bitcoin key, only what decrypts the eventual
   *  accept/decline ack. `replyPublicKey` is the same value embedded in
   *  `response_channel.requester_pubkey` above. */
  replyPrivateKey: string;
  replyPublicKey: string;
}

/**
 * Pick the leaf hex this role actually appears in, out of a compiled
 * vault's leaf_scripts map. Returns an empty array (never throws) when a
 * named leaf isn't present -- e.g. a vault with no recovery timelock
 * configured has no "recovery" entry, and a founder's membership is still
 * valid for founders_now alone.
 *
 * A generic leaf-list vault has no entry in LEAVES_FOR_ROLE at all --
 * there, `role` IS the leaf's own id (VaultMembershipSetup.tsx's
 * leaf-list branch passes `leaf.id` as the role for exactly this
 * reason), and compile-leaves.js's leaf_scripts map is already keyed by
 * leaf id directly, so the fallback below looks it up with no extra
 * indirection. A key that legitimately sits in more than one leaf (the
 * key-reuse pattern policy_compiler.rs's find_key_reuse already
 * recognizes) simply gets one membership grant per leaf it's actually
 * in, driven by the vault's real structure rather than a fixed mapping.
 */
export function leafScriptsForRole(
  leafScripts: Record<string, string> | null,
  role: VaultMembershipRole,
): string[] {
  if (!leafScripts) return [];
  const namedRoleLeaves = LEAVES_FOR_ROLE[role as keyof typeof LEAVES_FOR_ROLE];
  if (namedRoleLeaves) {
    return namedRoleLeaves
      .map(name => leafScripts[name])
      .filter((hex): hex is string => typeof hex === 'string' && hex.length > 0);
  }
  const hex = leafScripts[role];
  return typeof hex === 'string' && hex.length > 0 ? [hex] : [];
}

/**
 * Encrypt and durably queue a vault-membership request for one circle
 * member's real Tapit pubkey. Call once per member (fan-out is the
 * caller's job, same as sendCirclePhrasePairOverNostr).
 */
export async function sendVaultMembershipRequestOverNostr(opts: {
  vaultDescriptor: string;
  vaultName: string;
  role: VaultMembershipRole;
  leafScripts: string[];
  highValueThresholdSats?: bigint;
  recipientXOnlyPubkey: string;
  relays?: readonly string[];
}): Promise<SendVaultMembershipResult> {
  const ephemeral = generateEphemeralKeypair();
  const replyChannel = generateEphemeralKeypair();
  const payload: VaultMembershipRequestPayload = {
    v: 1,
    vault_descriptor: opts.vaultDescriptor,
    vault_name: opts.vaultName,
    role: opts.role,
    leaf_scripts: opts.leafScripts,
    ...(opts.highValueThresholdSats !== undefined
      ? { high_value_threshold_sats: opts.highValueThresholdSats.toString() }
      : {}),
    response_channel: { kind: 'nostr', requester_pubkey: replyChannel.publicKey },
  };
  const ciphertext = encryptTo(
    JSON.stringify(payload),
    opts.recipientXOnlyPubkey,
    ephemeral.privateKey,
  );
  const event = await buildEvent({
    pubkey: ephemeral.publicKey,
    sign: digest => toHex(schnorr.sign(digest, ephemeral.privateKey)),
    kind: VAULT_MEMBERSHIP_REQUEST_KIND,
    content: ciphertext,
    tags: [['p', opts.recipientXOnlyPubkey]],
  });

  const relays = opts.relays ?? DEFAULT_RELAYS;
  await nostrOutbox.enqueue({
    event,
    relays,
    label: `Vault membership -- ${opts.vaultName} (${opts.role})`,
  });

  const transport = new NostrTransport({ relays });
  const replyKeys = { replyPrivateKey: replyChannel.privateKey, replyPublicKey: replyChannel.publicKey };
  try {
    const publish = await transport.publish(event);
    if (publish.accepted.length > 0) {
      await nostrOutbox.markSent(event.id);
      return { eventId: event.id, delivered: true, ...replyKeys };
    }
    await nostrOutbox.markAttempt(event.id, 'no relay accepted on first attempt');
    return { eventId: event.id, delivered: false, ...replyKeys };
  } catch (e) {
    await nostrOutbox.markAttempt(event.id, e instanceof Error ? e.message : 'publish failed');
    return { eventId: event.id, delivered: false, ...replyKeys };
  } finally {
    transport.close();
  }
}
