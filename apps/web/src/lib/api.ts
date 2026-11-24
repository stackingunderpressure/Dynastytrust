import { supabase } from './supabase';
import { messagingKeyLocked, unlockMessagingKey, type EncryptedMessage } from './messaging';
import { broadcastTxUrl, type Network } from '../config';
import type { ProofOfLife, DuressFlag } from 'tapit-attest';
import type { SpendingPathSummary } from './vault-spending-paths';
import type { AnchorCheck, LedgerAnchor, LedgerCheck, LedgerEntry } from './ledger-verify';
import { ensureVaultKey } from './use-vault-key';
import { LOCKED_TEXT, loadAllMyVaultKeys, sealVaultJson, sealVaultText, vaultKeyVersion } from './vault-keyring';
import { savePending } from './sealed-pending';
import {
  F, openAttestation, openInvite, openMember, openProposal, openRequest, openSecret, openSealedDeep, openSessionLabel, openStipend, openVault, openWallet,
} from './sealed-fields';
import { openVaultText } from './vault-keyring';
import { isSealed } from './vault-key';

// In production, /api/* is redirected to /.netlify/functions/* by netlify.toml.
// In local dev with `netlify dev`, the same redirect applies automatically.
const API = '/api';

async function getToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not authenticated');
  return token;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text);
  } catch {
    // Non-JSON response - surface the raw text as a readable error
    throw new Error(
      res.ok
        ? `Unexpected response from server (not JSON): ${text.slice(0, 120)}`
        : `Server error ${res.status}: ${text.slice(0, 120)}`
    );
  }
  if (!res.ok) throw new Error((payload.error as string) ?? `Request failed: ${res.status}`);
  return payload as T;
}

// --- zero-knowledge storage (lib/vault-keyring.ts, lib/sealed-fields.ts) ---
// Names, labels and the trust document are sealed here before they are sent
// and opened here when they come back, so pages only ever see plain text.

/** Placeholder the server stores until the owner's device seals the real
 *  name (a new vault has no id -- and so no key -- until it exists). */
const PLACEHOLDER_NAME = 'Vault';

let listKeys: Promise<void> | null = null;
/** Every vault key addressed to me, loaded once per page (and again after a
 *  failure, e.g. while the messaging key was still behind Face ID). */
function keysForLists(): Promise<void> {
  if (!listKeys) {
    listKeys = (async () => {
      const { data } = await supabase.auth.getSession();
      const me = data.session?.user.id;
      if (!me) return;
      // Behind Face ID the wraps cannot be opened yet: load, but do not keep
      // the result, so the next list after unlocking opens the names.
      const locked = messagingKeyLocked();
      await loadAllMyVaultKeys(() => req(`/vault-keys`), me);
      if (locked) listKeys = null;
    })().catch(() => { listKeys = null; });
  }
  return listKeys;
}
/** Call after the messaging key unlocks so lists re-open what they can. */
export function reloadVaultKeys(): void { listKeys = null; }

/** The person is saving something: if the key that opens the vault key is
 *  behind Face ID, ask for it now rather than failing the save. */
async function keyFor(vaultId: string): Promise<void> {
  if (vaultKeyVersion(vaultId) > 0) return;
  if (messagingKeyLocked()) {
    await unlockMessagingKey();
    reloadVaultKeys();
  }
  await ensureVaultKey(vaultId);
}

async function seal<T extends string | null | undefined>(vaultId: string, field: string, v: T): Promise<T | string> {
  if (v === null || v === undefined || v === '') return v;
  await keyFor(vaultId);
  return sealVaultText(vaultId, field, v);
}

async function sealJson(vaultId: string, field: string, v: unknown): Promise<{ zk: string }> {
  await keyFor(vaultId);
  return sealVaultJson(vaultId, field, v);
}

async function opened<R extends { vault?: Vault }>(p: Promise<R>): Promise<R> {
  const r = await p;
  if (!r.vault) return r;
  await keysForLists();
  return { ...r, vault: openVault(r.vault) };
}

/** A vault was just created under the placeholder name: make its key (we are
 *  the owner) and store the real name sealed. If that cannot happen now (the
 *  messaging key is locked, the network dropped), the name waits on this
 *  device and is sealed the next time the vault is opened. */
async function nameNewVault<R extends { vault?: Vault }>(name: string | undefined, p: Promise<R>): Promise<R> {
  const r = await p;
  if (!r.vault) return r;
  const id = r.vault.id;
  const plain = (name ?? '').trim();
  if (!plain || plain === PLACEHOLDER_NAME || plain === LOCKED_TEXT) return opened(Promise.resolve(r));
  try {
    const sealed = await seal(id, F.vaultName, plain);
    const renamed = await req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: sealed }),
    });
    return { ...r, vault: openVault(renamed.vault) };
  } catch {
    savePending(id, { name: plain });
    return { ...r, vault: { ...openVault(r.vault), name: plain } };
  }
}

/** Updates that carry a sealed field must say which vault seals it. */
function needVault(vaultId: string | undefined): string {
  if (!vaultId) throw new Error('Internal: this change needs its vault to be sealed.');
  return vaultId;
}

/** compile() with save: true inserts a vault, so it is named like any new vault. */
function compileAndName<R extends { vault?: Vault }>(save: boolean | undefined, name: string, p: Promise<R>): Promise<R> {
  return save ? nameNewVault(name, p) : p;
}

//

export type VaultStatus = 'draft' | 'compiled' | 'archived';

export interface Vault {
  id: string;
  created_at: string;
  updated_at: string;
  user_id: string;
  name: string;
  network: 'testnet' | 'signet' | 'bitcoin';
  // Null for drafts, set after compile.
  address: string | null;
  descriptor: string | null;
  miniscript_policy: string | null;
  address_type: 'wsh' | 'tr' | 'tr_multileaf';
  founder_quorum: number;
  heir_quorum: number;
  /** Quorum for the timelocked recovery branch. Null = legacy
   *  (same as founder_quorum); set explicitly on new vaults so
   *  Path 2 unlocks a different capability than Path 1. */
  recovery_quorum: number | null;
  recovery_after: number;
  inheritance_after: number;
  founder_keys: string[];
  heir_keys: string[];
  /** Beneficiary-consent gate on Path 1. Every normal spend requires
   *  trustees AND this many beneficiary signatures. The timelocked
   *  paths ignore consent -- they exist to rescue funds when a
   *  beneficiary can't or won't cosign. Empty = not configured. */
  consent_keys: string[];
  consent_quorum: number | null;
  /** "Anytime, harder" fallback branch (027_backup_path.sql) -- the
   *  owner's own SEPARATE, harder-to-reach key set (e.g. keys split
   *  across physical locations), spendable immediately with no
   *  timelock, at a quorum typically stricter than founder_quorum.
   *  Mutually exclusive with a timelocked recovery leaf (recovery_after
   *  > 0) -- the compiler rejects both set at once. Empty = not
   *  configured, meaning recovery_after (if any) governs Path 2 instead. */
  backup_keys: string[];
  backup_quorum: number | null;
  /** Second, independent inheritance leaf (2026-08-11) -- a distinct
   *  heir cohort with its own key set, quorum, and absolute timelock
   *  alongside the primary heir_keys/heir_quorum/inheritance_after leaf.
   *  Requires the primary leaf to already be configured (heir_keys
   *  non-empty); deliberately unordered relative to inheritance_after --
   *  either shorter or longer is a valid design. Empty = not configured. */
  second_heir_keys: string[];
  second_heir_quorum: number | null;
  second_inheritance_after: number | null;
  archived: boolean;
  status: VaultStatus;
  /** Caller's role in this vault -- attached server-side so the
   *  Dashboard can render a role-aware view without an N+1 fetch. */
  my_role?: VaultRole | null;
  /** If this vault was created by rotating an older one, points
   *  to the predecessor. Lets the UI render a succession chain. */
  predecessor_id?: string | null;
  // Draft-only: how many signing slots the vault will have when
  // compiled. Null on legacy compiled rows.
  planned_founder_count: number | null;
  planned_heir_count: number | null;
  // Trust document: human-readable purpose, beneficiaries, and
  // distribution rules. The schema is flexible; the UI reads the
  // fields it knows about and round-trips the rest.
  trust_doc: TrustDoc;
  /** Vault-level duress/hold signal for the fail-closed signing gate
   *  (023_bloc_vaults.sql). When true, in-app signing must refuse and
   *  funds fall to the timelock backstop. Defaults false server-side. */
  duress: boolean;
  /** Present only on a Dynasty Bloc vault (decaying-multisig family
   *  shape) -- null for every standard founders/heirs vault. Presence,
   *  not a separate type column, is the discriminator (023_bloc_vaults.sql). */
  bloc_policy: BlocPolicy | null;
  /** Hex-encoded tapscript leaf bytes per role ("founders_now",
   *  "recovery" OR "backup" -- mutually exclusive, "inheritance"),
   *  populated by the compiler
   *  for a tr_multileaf vault only (026_leaf_scripts.sql). This is the
   *  source data for minting a vault-membership attestation (Cut C3,
   *  circle-membership-delivery.ts) -- what proves to a Tapit circle
   *  member's wallet which exact leaf its key appears in, so a later
   *  psbt-cosign request can be checked against a leaf the wallet was
   *  actually told about at vault-creation time. Null for non-multileaf
   *  address types and Bloc vaults. */
  leaf_scripts: Record<string, string> | null;
  /** Per-key custom display labels (041_vault_key_labels.sql), keyed by
   *  bare pubkey -- independent of vault_members (covers every key
   *  regardless of whether it has a DynastyTrust account behind it) and
   *  independent of key_origins (covers a Tapit-origin key, which has no
   *  BIP32 fingerprint/derivation_path to key_origins off of). Empty
   *  array = no custom labels set; a key with no entry here falls back
   *  to a positional Owner/Trustee default (see VaultStructureTree's
   *  keyLabel) or vault_members.label. 2026-08-15, operator: "make sure
   *  that each spot of every vault and every key has a spot to assign
   *  that label to it where it needs to be." */
  key_labels: { pubkey: string; label: string }[];
  /** Generic leaf-list vault (migration 042, the "toggle-a-leaf" builder)
   *  -- present only for a vault created via createLeavesDraft, null for
   *  every founders/heirs and Bloc vault. Presence, not a separate type
   *  column, is the discriminator, same pattern as bloc_policy. Before
   *  compile, unlock.blocks on an "after" entry is a RELATIVE offset;
   *  compile-leaves.js overwrites it with the absolute height baked into
   *  the compiled tree, same as recovery_after/inheritance_after above.
   *  An "older" entry's blocks is always a duration, never converted. */
  leaves: LeafSpec[] | null;
  /** BIP32 origins for hardware-wallet signing (fingerprint +
   *  derivation_path per signer, keyed by pubkey elsewhere) -- see
   *  psbt-binary.js's attach_tap_key_origins. Optional on this type
   *  since most reads of a Vault don't select it; present when the
   *  server does (e.g. after a compile or a key_origins repair PATCH). */
  key_origins?: { pubkey: string; fingerprint: string; derivation_path: string }[];
}

export type LeafUnlock =
  | { type: 'immediate' }
  | { type: 'after'; blocks: number }
  | { type: 'older'; blocks: number };

export interface LeafDecay {
  step_blocks: number;
  floor_quorum: number;
}

/** One spending path in a generic leaf-list vault. `keys` is empty on a
 *  freshly-created draft (Configure only picks quorum/timing/decay --
 *  see VaultWizard's leaf builder) and filled in before compile via
 *  api.vaults.updateLeaves, mirroring how a standard draft's key slots
 *  are filled in the Keys step before api.vaults.compile. */
export interface LeafSpec {
  id: string;
  label: string;
  keys: string[];
  quorum: number;
  unlock: LeafUnlock;
  decay: LeafDecay | null;
  /** Draft only: how many key slots this path has (see VaultWizard's
   *  leafDraftToSpec). Absent on a compiled vault. */
  planned_keys?: number;
  /** Keys that must EACH sign on this path, on top of `quorum` of `keys`
   *  (protocol::Leaf::required_keys). Never also in `keys`. Absent or
   *  empty on a path with none. */
  required_keys?: string[];
  /** Draft only: how many must-sign slots this path has. */
  planned_required?: number;
}

/** The whole Bloc policy the compiler needs to rebuild the exact tree
 *  for a spend -- must match what /compile-bloc baked into the address.
 *  key_origins carries fingerprint + derivation_path per signer; Bloc
 *  vaults have no vault_members table to carry that separately the way
 *  the standard shape does. */
export interface BlocPolicy {
  parent_pubkeys: string[];
  kid_pubkeys: string[];
  parent_xpubs: string[];
  kid_xpubs: string[];
  parents_together_quorum: number;
  coparent_quorum: number;
  kids_with_parent_quorum: number;
  parent_solo_quorum: number;
  kids_decay_start_quorum: number;
  kids_decay_floor_quorum: number;
  parent_solo_after: number;
  kids_decay_start_after: number;
  kids_decay_step_blocks: number;
  key_origins: { pubkey: string; fingerprint: string; derivation_path: string }[];
}

/** A password-encrypted record of a secret the owner sent to a circle
 *  member (032_sent_secrets.sql). recipients/label/kind/created_at are
 *  plain (just bookkeeping); ciphertext_b64/salt_b64/nonce_b64 are the
 *  AES-256-GCM-encrypted secret fields -- decrypt client-side only, via
 *  lib/sent-secrets.ts's unwrapSentSecret. */
export interface SentSecret {
  id: string;
  kind: string;
  label: string;
  recipients: { label: string; persona: string }[];
  ciphertext_b64: string;
  salt_b64: string;
  nonce_b64: string;
  created_at: string;
}

// Persisted "granted membership" state + the accept/decline ack round
// trip (033_vault_membership_grants.sql). One row per (vault, role, key)
// a membership request was sent for; status moves sent -> accepted /
// declined once the member's wallet acks over the vault-membership-ack
// Nostr channel (vault-membership-ack-channel.ts).
export interface VaultMembershipGrant {
  id: string;
  role: string;
  key_id: string;
  recipient_label: string;
  recipient_persona: string;
  recipient_pubkey: string;
  request_event_id: string | null;
  reply_pubkey: string;
  /** Legacy readable reply key; new rows use reply_privkey_sealed (lib/reply-key-seal.ts). */
  reply_privkey: string | null;
  reply_privkey_sealed?: EncryptedMessage | null;
  // 'left' (2026-08-15, operator: "when you disengage from it and you
  // want to delete yourself from it, it would notify Dynasty Trust that
  // you have a trustee that's disconnected") is a member's own wallet
  // walking back an earlier 'accepted' -- distinct from 'declined' (never
  // accepted in the first place). The on-chain key isn't revoked by this;
  // see VaultMembershipSetup.tsx's STATUS_LABEL for the disclosure shown
  // alongside it.
  status: 'sent' | 'accepted' | 'declined' | 'left';
  responded_at: string | null;
  created_at: string;
  updated_at: string;
}

// Persisted send-status for the circle safety phrase pair
// (034_circle_phrase_deliveries.sql, 035_circle_phrase_delivery_confirm.sql)
// -- never the phrase text itself, only who/when/confirmed. `status`
// reflects relay-publish only; `confirmed_at` is set only once the
// recipient's own Tapit wallet acks actual receipt (kind 9581,
// circle-phrase-ack-channel.ts) -- see that migration's header for why
// these are two different, both-honest facts. See CirclePhraseSetup.tsx.
export interface CirclePhraseDelivery {
  id: string;
  recipient_key_id: string;
  recipient_label: string;
  recipient_persona: string;
  status: 'delivered' | 'queued';
  delivered_at: string;
  reply_pubkey: string | null;
  reply_privkey: string | null;
  reply_privkey_sealed?: EncryptedMessage | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrustDoc {
  /** One or two sentences: why does this trust exist? */
  purpose?: string;
  /** Named beneficiaries -- not necessarily signers. Receive
   *  distributions or inherit per the trust terms. */
  beneficiaries?: TrustBeneficiary[];
  /** Free-form distribution rules (human-readable, not enforced). */
  distribution_rules?: string;
  /** Successor trustee notes: who takes over, under what conditions. */
  succession_notes?: string;
  /** Structured distribution rules that gate the Send flow
   *  client-side. Each proposal can cite a rule and the Send form
   *  enforces its limits. */
  rules?: DistributionRule[];
}

export interface DistributionRule {
  /** Stable client-generated id so proposals reference a specific
   *  rule even if the trustee later renames it. */
  id: string;
  name: string;
  /** Max BTC amount per proposal in sats. undefined/null = no cap. */
  max_sats?: number | null;
  /** Free-text legal/tax context, shown on the proposal. */
  notes?: string;
  /** If true, the Send form refuses to build without a reason note. */
  requires_comment?: boolean;
}

export interface TrustBeneficiary {
  name: string;
  relation?: string;
  notes?: string;
}

export type ProposalVote = 'approve' | 'abstain' | 'decline';

export type VaultRequestStatus = 'pending' | 'approved' | 'declined' | 'fulfilled' | 'cancelled';

export type StipendInterval = 'weekly' | 'monthly' | 'quarterly' | 'annually';

export interface DistributionTranche {
  index: number;
  unlock_block: number;
  amount_sats: number;
  address: string;
  descriptor: string;
  funded_txid?: string | null;
  claimed_txid?: string | null;
  label?: string | null;
}

export interface DistributionWallet {
  id: string;
  created_at: string;
  updated_at: string;
  vault_id: string;
  name: string;
  beneficiary_name: string | null;
  beneficiary_xpub: string;
  beneficiary_pubkey: string;
  trustee_keys: string[];
  trustee_quorum: number;
  tranches: DistributionTranche[];
  network: 'testnet' | 'signet' | 'bitcoin';
  /** BIP32 origins for hardware-wallet compatibility (2026-08-12 fix,
   *  037_tranche_key_origins.sql) -- one entry per key (beneficiary
   *  and/or trustees) that should be recognizable to a real hardware
   *  wallet. Empty degrades to browser/Tapit-only signing for this
   *  wallet, same fallback the standard vault's 2026-08-06 fix uses. */
  key_origins: { pubkey: string; fingerprint: string; derivation_path: string }[];
}

export interface ScheduledStipend {
  id: string;
  created_at: string;
  updated_at: string;
  vault_id: string;
  name: string;
  recipient_name: string | null;
  destination: string | null;
  rule_id: string | null;
  amount_sats: number;
  interval_kind: StipendInterval;
  next_due_at: string;
  last_proposed_at: string | null;
  last_proposal_id: string | null;
  active: boolean;
}

export interface VaultRequest {
  id: string;
  created_at: string;
  updated_at: string;
  vault_id: string;
  requested_by: string;
  rule_id: string | null;
  rule_name: string | null;
  amount_sats: number;
  recipient_name: string | null;
  reason: string | null;
  status: VaultRequestStatus;
  linked_proposal_id: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
}

export interface ProposalComment {
  id: string;
  created_at: string;
  proposal_id: string;
  user_id: string;
  body: string | null;
  vote: ProposalVote | null;
  /** Body + vote sealed with the vault key (lib/vault-key.ts); body/vote are null when set. */
  sealed?: string | null;
}

/** One signer's row on a proposal -- who's been asked to sign and whether
 *  they have. Embedded on every Proposal returned by GET /proposals
 *  (proposals.js's select already joins signer_sessions); this type just
 *  names the shape so the UI can render it. */
export interface ProposalSignerSession {
  id: string;
  signer_index: number;
  /** The member's role when they signed. Rows before 2026-11-12 hold only founder or heir. */
  signer_role: 'owner' | 'founder' | 'heir' | 'protector' | 'beneficiary' | string;
  label: string | null;
  signed: boolean;
  signed_at: string | null;
  fingerprint: string | null;
  member_id: string | null;
}

export interface Proposal {
  id: string;
  created_at: string;
  vault_id: string;
  // A leaf-list vault's proposals use the leaf's own id as path (never
  // one of the fixed named-field/Bloc/tranche ids below), matching
  // psbt-binary.js's leafListSignerCounts convention -- `(string & {})`
  // keeps the known literals' autocomplete while accepting that too,
  // same widening pattern circle-membership-delivery.ts's
  // VaultMembershipRole already uses for the same reason.
  path:
    | 'founders_now'
    | 'recovery'
    | 'inheritance'
    | 'protector'
    | 'backup'
    | 'second_inheritance'
    | 'parents_now'
    | 'coparent_kids'
    | 'parent_solo'
    | 'kids_decay'
    | 'tranche_claim'
    | (string & {});
  destination: string;
  amount_sats: number;
  fee_sats: number;
  status: 'draft' | 'pending' | 'signed' | 'broadcast' | 'cancelled';
  psbt_hex?: string;
  psbt_b64?: string;
  txid?: string;
  memo?: string;
  governance_audit?: unknown;
  /** Present on every proposal returned by GET /proposals (list); absent
   *  on the single-proposal shape POST/PATCH return. */
  signer_sessions?: ProposalSignerSession[];
  /** Set only on path='tranche_claim' proposals -- which distribution
   *  wallet + tranche this claim is for (036_tranche_claim_proposals.sql). */
  distribution_wallet_id?: string | null;
  tranche_index?: number | null;
}

export interface BalanceResult {
  ok: boolean;
  address: string;
  network: string;
  confirmed_sats: number;
  unconfirmed_sats: number;
  total_sats: number;
  btc_amount: number;
  btc_price_usd: number | null;
  usd_value: number | null;
  utxo_count: number;
  confirmed_utxos: number;
  mempool_url: string;
  tx_count: number;
}

// Multi-member vault types (B1 schema in db/migrations/003_members.sql).
// Endpoints land in B2; these types let the UI start consuming them
// without a round-trip.

export type VaultRole = 'owner' | 'founder' | 'heir' | 'protector' | 'viewer' | 'beneficiary';
export type VaultMemberStatus = 'active' | 'pending' | 'removed';

export interface VaultMember {
  id: string;
  created_at: string;
  vault_id: string;
  user_id: string;
  role: VaultRole;
  label: string | null;
  xpub: string | null;
  fingerprint: string | null;
  pubkey: string | null;
  derivation_path: string | null;
  key_label: string | null;
  status: VaultMemberStatus;
  /** X25519 public key for end-to-end encrypted messaging.
   *  Published the first time the member opens a vault they
   *  belong to; corresponds to a private key that never leaves
   *  their browser. */
  messaging_pubkey?: string | null;
  /** Path-builder vaults: the path this person was invited to hold a
   *  key on, and when the owner confirmed that key by its fingerprint.
   *  Only a confirmed key can be compiled into a vault. */
  leaf_id?: string | null;
  /** True when this person was invited to hold one of leaf_id's
   *  must-sign keys (a key every spend on that path needs). */
  must_sign?: boolean;
  key_confirmed_at?: string | null;
  key_confirmed_by?: string | null;
}

export interface VaultMessage {
  id: string;
  vault_id: string;
  sender_user_id: string;
  sender_pubkey: string;
  created_at: string;
  subject: string | null;
  thread_id: string | null;
  nonce: string;
  ciphertext: string;
  recipients: {
    user_id: string;
    pubkey: string;
    wrap_nonce: string;
    wrapped_key: string;
  }[];
}

export type AttestationType =
  | 'trust_doc'
  | 'proof_of_life'
  | 'death_declaration'
  | 'descriptor';

export interface VaultAttestation {
  id: string;
  vault_id: string;
  user_id: string;
  attestation_type: AttestationType;
  target_hash: string;
  target_data: Record<string, unknown>;
  signature: string;
  pubkey: string;
  signed_at: string;
}

export interface VaultInvite {
  id: string;
  created_at: string;
  vault_id: string;
  invited_by: string;
  invited_role: Exclude<VaultRole, 'owner'>;
  invited_label: string | null;
  invited_email: string | null;
  /** Path-builder vaults: the path this invite fills a key slot on. */
  leaf_id?: string | null;
  /** True when the slot is one of the path's must-sign keys. */
  must_sign?: boolean;
  token: string;
  expires_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
}

//

/** GET /api/vault-keys (zero-knowledge storage, lib/vault-key.ts). */
export interface VaultKeysState {
  ok: true;
  version: number;
  owner_user_id: string;
  checks: Record<string, string>;
  mine: { version: number; wrap: EncryptedMessage }[];
  current_holders: { user_id: string; pubkey: string | null }[];
  members: { user_id: string; messaging_pubkey: string | null }[];
}

export const api = {
  vaults: {
    list: async (showArchived = false) => {
      const r = await req<{ ok: true; vaults: Vault[] }>(`/vaults${showArchived ? '?archived=true' : ''}`);
      await keysForLists();
      return { ...r, vaults: r.vaults.map(openVault) };
    },

    create: (body: {
      name: string;
      network: 'testnet' | 'signet' | 'bitcoin';
      address: string;
      descriptor: string;
      miniscript_policy: string;
      address_type?: string;
      founder_quorum?: number;
      heir_quorum?: number;
      recovery_quorum?: number | null;
      recovery_after?: number;
      inheritance_after?: number;
      founder_keys?: string[];
      heir_keys?: string[];
      consent_keys?: string[];
      consent_quorum?: number | null;
      /** TOS version the user accepted. Server writes a
       *  terms_accepted vault_event with this string + timestamp. */
      terms_accepted_version?: string;
    }) => nameNewVault(body.name, req<{ ok: true; vault: Vault }>('/vaults', {
      method: 'POST',
      body: JSON.stringify({ ...body, name: PLACEHOLDER_NAME }),
    })),

    // Persist a compiled Dynasty Bloc vault (023_bloc_vaults.sql added
    // the bloc_policy column for exactly this; wired to a save path
    // 2026-08-06). Mirrors create() -- pass the already-compiled
    // address/descriptor/miniscript_policy from compileBloc()'s response,
    // plus the full policy the compiler needs to rebuild the tree for a
    // future spend (see BlocPolicy). Single-owner shape: no member slots.
    createBloc: (body: {
      name: string;
      network: 'testnet' | 'signet' | 'bitcoin';
      address: string;
      descriptor: string;
      miniscript_policy: string;
      bloc_policy: BlocPolicy;
      terms_accepted_version?: string;
    }) => nameNewVault(body.name, req<{ ok: true; vault: Vault }>('/vaults', {
      method: 'POST',
      body: JSON.stringify({ ...body, name: PLACEHOLDER_NAME, mode: 'bloc' }),
    })),

    // Shape-only Bloc vault: quorums/timelocks picked, key slots still
    // empty or partial. address_type + name + network only -- bloc_policy
    // is a Partial<BlocPolicy> here (RELATIVE timelocks, since nothing's
    // compiled yet). Call vaults.compileBloc() later once every slot is
    // filled to turn this into a real, spendable vault.
    createBlocDraft: (body: {
      name: string;
      network: 'testnet' | 'signet' | 'bitcoin';
      address_type?: string;
      bloc_policy: Partial<BlocPolicy>;
    }) => nameNewVault(body.name, req<{ ok: true; vault: Vault }>('/vaults', {
      method: 'POST',
      body: JSON.stringify({ ...body, name: PLACEHOLDER_NAME, mode: 'bloc-draft' }),
    })),

    // Compiles a draft Bloc vault (created via createBlocDraft) into a
    // live, spendable one, once every parent/kid slot has a real key.
    compileBloc: (body: {
      vault_id: string;
      parent_keys: string[];
      kid_keys: string[];
      parent_xpubs: string[];
      kid_xpubs: string[];
      key_origins: { pubkey: string; fingerprint: string; derivation_path: string }[];
    }) => opened(req<{ ok: true; vault: Vault }>('/vaults-compile-bloc', {
      method: 'POST',
      body: JSON.stringify(body),
    })),

    // Draft vault: no descriptor yet. Members bring their xpubs via
    // invites; owner calls compile() once every slot is full.
    createDraft: (body: {
      name: string;
      network: 'testnet' | 'signet' | 'bitcoin';
      address_type?: 'wsh' | 'tr' | 'tr_multileaf';
      planned_founder_count: number;
      planned_heir_count: number;
      founder_quorum?: number;
      heir_quorum?: number;
      recovery_quorum?: number | null;
      recovery_after?: number;
      inheritance_after?: number;
      consent_quorum?: number | null;
      backup_quorum?: number | null;
      second_heir_quorum?: number | null;
      second_inheritance_after?: number | null;
    }) =>
      nameNewVault(body.name, req<{ ok: true; vault: Vault }>('/vaults', {
        method: 'POST',
        body: JSON.stringify({ ...body, name: PLACEHOLDER_NAME, mode: 'draft' }),
      })),

    // direct_keys: the SAME owner brings every key themselves (no
    // invite/vault_members involvement) -- for finishing a draft vault
    // whose Configure step ran before every key slot was filled.
    // Omit for the invite-based flow (members bring their own xpub via
    // a claim link).
    compile: (vault_id: string, direct_keys?: {
      founder_keys?: { pubkey: string; xpub: string; fingerprint: string; derivation_path: string }[];
      heir_keys?: { pubkey: string; xpub: string; fingerprint: string; derivation_path: string }[];
      consent_keys?: { pubkey: string; xpub: string; fingerprint: string; derivation_path: string }[];
      backup_keys?: { pubkey: string; xpub: string; fingerprint: string; derivation_path: string }[];
      second_heir_keys?: { pubkey: string; xpub: string; fingerprint: string; derivation_path: string }[];
    }) =>
      opened(req<{ ok: true; vault: Vault }>('/vaults-compile', {
        method: 'POST',
        body: JSON.stringify(direct_keys ? { vault_id, direct_keys } : { vault_id }),
      })),

    // Shape-only generic leaf-list vault (migration 042): the primary
    // path plus whichever secondary paths the operator picked are saved
    // with quorum/unlock/decay set but keys empty -- mirrors
    // createBlocDraft's role exactly, just for the generic shape instead
    // of the fixed Bloc one. Call updateLeaves() once real keys are
    // picked in the Keys step, then compileLeaves() to turn this into a
    // real, spendable vault.
    createLeavesDraft: (body: {
      name: string;
      network: 'testnet' | 'signet' | 'bitcoin';
      address_type?: string;
      leaves: LeafSpec[];
    }) => nameNewVault(body.name, req<{ ok: true; vault: Vault }>('/vaults', {
      method: 'POST',
      body: JSON.stringify({ ...body, name: PLACEHOLDER_NAME, mode: 'leaves-draft' }),
    })),

    // Saves the operator's in-progress leaf configuration onto a
    // leaves-draft row -- draft-only server-side (same "can't touch this
    // after compile" guard as updateNetwork above, since editing the
    // policy after the address is derived would leave the DB describing
    // a different vault than the one that's actually funded).
    updateLeaves: (id: string, leaves: LeafSpec[]) =>
      opened(req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ leaves }),
      })),

    // Compiles a leaves-draft (created via createLeavesDraft, keys filled
    // in via updateLeaves) into a live, spendable vault. Unlike
    // compile()/compileBloc(), the leaf keys themselves aren't passed
    // here -- they're already saved on the draft row by the time this is
    // called. key_origins IS passed here, though -- unlike the standard
    // and Bloc shapes (which write it during their own compile call), the
    // leaf-list shape had no equivalent at all until this fix, so no
    // leaf-list vault ever got BIP371 tap_key_origins and a real hardware
    // wallet correctly refused to sign ("did not add a valid signature").
    compileLeaves: (vault_id: string, key_origins?: { pubkey: string; fingerprint: string; derivation_path: string }[]) =>
      opened(req<{ ok: true; vault: Vault }>('/compile-leaves', {
        method: 'POST',
        body: JSON.stringify({ vault_id, key_origins }),
      })),

    archive: (id: string) =>
      opened(req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: true }),
      })),

    remove: (id: string) =>
      req<{ ok: true }>(`/vaults?id=${id}`, { method: 'DELETE' }),

    rotate: (body: {
      vault_id: string;
      overrides?: {
        name?: string;
        recovery_after?: number;
        inheritance_after?: number;
        founder_quorum?: number;
        heir_quorum?: number;
        recovery_quorum?: number | null;
        /** Path-builder vaults only: blocks from the successor's compile
         *  for each dated path, keyed by path id (lib/rotate-plan.ts). */
        leaf_offsets?: Record<string, number>;
      };
    }) => (async () => {
      // The successor is a new vault (new id, new key): the server copies the
      // predecessor's sealed values, which open through predecessor_id; the
      // name is re-sealed under the successor's own key right away.
      const { name, ...rest } = body.overrides ?? {};
      const raw = await req<{ ok: true; vault: Vault }>(`/vaults-rotate`, {
        method: 'POST',
        body: JSON.stringify({ ...body, overrides: rest }),
      });
      const copiedSealed = isSealed(raw.vault.name);
      const r = await opened(Promise.resolve(raw));
      // The server adds " v2" only to a readable name (vaults-rotate.js).
      const next = name ?? (copiedSealed && r.vault.name !== LOCKED_TEXT ? `${r.vault.name} v2` : r.vault.name);
      return nameNewVault(next, Promise.resolve(r));
    })(),

    rename: async (id: string, name: string) =>
      opened(req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: await seal(id, F.vaultName, name) }),
      })),

    // Draft-only server-side (netlify/functions/vaults.js rejects this once
    // status is "compiled" -- the address/descriptor are already derived
    // FOR the old network by then, and swapping the label afterward would
    // silently point at the wrong chain). Lets VaultWizard's Keys step fix
    // a vault that landed on the wrong network before any keys are added.
    updateNetwork: (id: string, network: 'testnet' | 'signet' | 'bitcoin') =>
      opened(req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ network }),
      })),

    // Owner-only. Assigns/changes/clears the display label for one key
    // slot -- e.g. "Owner" vs "Trustee" for a circle-of-people vault's
    // founder keys, independent of the technical founder/heir/etc. role.
    // label: null (or an empty string) clears it, reverting that key to
    // its positional default. See key_labels' doc comment on the Vault
    // type for why this exists separately from key_origins.
    setKeyLabel: async (id: string, pubkey: string, label: string | null) =>
      opened(req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ key_label: { pubkey, label: await seal(id, F.keyLabel, label) } }),
      })),

    // Self-heal for a leaf-list vault compiled before compile-leaves.js
    // wrote key_origins -- see the 2026-08-25 CLAUDE.md entry. Owner-only,
    // rejected server-side for any non-leaf-list vault.
    repairKeyOrigins: (id: string, key_origins: { pubkey: string; fingerprint: string; derivation_path: string }[]) =>
      opened(req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ key_origins }),
      })),

    updateTrustDoc: async (id: string, trust_doc: TrustDoc) =>
      opened(req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ trust_doc: await sealJson(id, F.trustDoc, trust_doc) }),
      })),

    // The plain, one-tap halt: true blocks every signing path on this vault
    // immediately (evaluateSigningGate's fail-closed duress check, already
    // enforced at sign time -- see VaultDetail's signing flow). false lifts
    // it. No phrase, no per-signer targeting -- for when a member can act
    // freely and just needs to stop everything right now.
    setDuress: (id: string, duress: boolean) =>
      opened(req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ duress }),
      })),
  },

  balance: (address: string, network: 'testnet' | 'signet' | 'bitcoin') =>
    req<BalanceResult>(`/balance?address=${encodeURIComponent(address)}&network=${network}`),

  utxos: (vault_id: string) =>
    req<{
      ok: true;
      vault_address: string;
      network: 'testnet' | 'signet' | 'bitcoin';
      tip: number | null;
      utxos: {
        txid: string;
        vout: number;
        value_sats: number;
        confirmed: boolean;
        block_height: number | null;
        block_time: number | null;
        confirmations: number;
      }[];
    }>(`/utxos?vault_id=${vault_id}`),

  compile: (body: {
    name: string;
    network: 'testnet' | 'signet' | 'bitcoin';
    address_type?: string;
    founder_keys: string[];
    founder_quorum: number;
    recovery_quorum?: number | null;
    heir_keys: string[];
    heir_quorum: number;
    recovery_after: number;
    inheritance_after: number;
    consent_keys?: string[];
    consent_quorum?: number | null;
    save?: boolean;
  }) => compileAndName(body.save, body.name, req<{
    ok: true;
    compiled: unknown;
    saved: boolean;
    vault?: Vault;
    // The Netlify compile function converts relative block
    // offsets into absolute CLTV heights server-side. Callers
    // MUST store these values against the vault row so the
    // address and the DB agree on what `after(N)` actually is.
    absolute_timelocks?: {
      recovery_after: number;
      inheritance_after: number;
      tip_height: number;
    };
  }>('/compile', {
    method: 'POST',
    body: JSON.stringify(body.save ? { ...body, name: PLACEHOLDER_NAME } : body),
  })),

  // Dynasty Bloc: decaying-multisig family vault. Phase 1 is
  // compile-only (address + descriptor + export); the bloc shape is
  // not yet persisted to the founders/heirs-shaped vaults table.
  // Timelock fields are RELATIVE block offsets; the netlify function
  // bakes tip + offset into absolute CLTV heights before forwarding.
  compileBloc: (body: {
    name: string;
    network: 'testnet' | 'signet' | 'bitcoin';
    parent_keys: string[];
    parents_together_quorum: number;
    coparent_quorum: number;
    kid_keys: string[];
    kids_with_parent_quorum: number;
    parent_solo_after: number;
    parent_solo_quorum: number;
    kids_decay_start_after: number;
    kids_decay_step_blocks: number;
    kids_decay_start_quorum: number;
    kids_decay_floor_quorum: number;
  }) => req<{
    ok: true;
    compiled: {
      address: string;
      descriptor: string;
      miniscript_policy: string;
      network: string;
      address_type: string;
    };
    absolute_timelocks: {
      parent_solo_after: number;
      kids_decay_start_after: number;
      tip_height: number;
    };
  }>('/compile-bloc', {
    method: 'POST',
    body: JSON.stringify(body),
  }),

  // Dynasty Bloc spend: builds an unsigned PSBT for one of the bloc's
  // spend paths. UTXOs are fetched server-side for the compiled
  // address. Timelock fields are ABSOLUTE block heights (captured from
  // the compile response's `absolute_timelocks`), NOT relative offsets.
  // This BUILDS and EXPORTS the PSBT only -- the user signs in their
  // hardware wallet, then finalizes + broadcasts.
  psbtBloc: (body: {
    // The server looks up address + the whole policy (including
    // key_origins) from the vaults row -- pass just this and
    // destination/amount/path. (2026-08-21: the un-persisted/legacy
    // direct-policy form was removed -- BlocBuilder.tsx, its only
    // caller, was retired when VaultWizard absorbed it; see
    // netlify/functions/psbt-binary-bloc.js's header, Kimi K3 scan #4/#38.)
    vault_id: string;
    destination: string;
    /** Required unless sweep is true -- see netlify/functions/psbt-binary-bloc.js. */
    amount_sats?: number;
    /** Send everything confirmed as one output with no change; the
     *  backend derives the real swept amount itself. */
    sweep?: boolean;
    fee_rate?: number;
    path: 'parents_now' | 'coparent_kids' | 'parent_solo' | 'kids_decay';
    // REQUIRED when path === 'kids_decay': which decay rung's quorum.
    quorum?: number;
  }) => req<{
    ok: true;
    psbt_hex: string;
    psbt_b64: string;
    summary: {
      amount_sats: number;
      fee_sats: number;
      change_sats: number;
      input_count: number;
      output_count: number;
      path: string;
    };
  }>('/psbt-binary-bloc', {
    method: 'POST',
    body: JSON.stringify(body),
  }),


  psbt: {
    generate: (body: {
      vault_id: string;
      destination: string;
      /** Required unless sweep is true -- the backend derives the real
       *  swept amount itself (totalIn minus the exact fee for that
       *  input count), so the caller never has to guess it. */
      amount_sats?: number;
      /** Send everything confirmed (or just the coin-controlled subset,
       *  if selected_utxos is also given) as one output with no change.
       *  See netlify/functions/psbt-binary.js for why this exists as a
       *  server-computed mode rather than a client-side amount guess. */
      sweep?: boolean;
      fee_rate?: number;
      path?: string;
      selected_utxos?: { txid: string; vout: number }[];
    }) => req<{
      ok: true;
      psbt_hex: string;
      psbt_b64: string;
      summary: {
        vault_name: string;
        vault_address: string;
        destination: string;
        amount_sats: number;
        fee_sats: number;
        change_sats: number;
        fee_rate: number;
        input_count: number;
        total_in_sats: number;
        network: string;
        path: string;
      };
    }>('/psbt-binary', { method: 'POST', body: JSON.stringify(body) }).then(async r => {
      await keysForLists();
      return { ...r, summary: { ...r.summary, vault_name: openVaultText(body.vault_id, F.vaultName, r.summary.vault_name) as string } };
    }),

    merge: (body: { vault_id: string; proposal_id?: string; psbts: string[] }) =>
      req<{ ok: true; psbt_hex: string; psbt_b64: string; signature_count: number; fully_signed: boolean }>(
        '/psbt-merge', { method: 'POST', body: JSON.stringify(body) }
      ),

    finalize: (psbt_hex: string) =>
      req<{ ok: true; raw_tx_hex: string; txid: string; vbytes: number }>(
        '/psbt-finalize', { method: 'POST', body: JSON.stringify({ psbt_hex }) }
      ),
  },

  governance: {
    // NOTE: `utxo_age_blocks` is a legacy field name. It carries the CURRENT
    // CHAIN TIP HEIGHT (absolute), not UTXO age -- timelocks are absolute CLTV,
    // so the engine compares it against the stored absolute unlock heights.
    // Pass the chain tip here, never the UTXO confirmation age.
    status: (body: {
      vault_id: string;
      utxo_age_blocks?: number;
    }) => req<{ ok: true; vault_name: string; result: {
      current_block: number;
      active_paths: string[];
      phase: string;
      status_label: string;
      blocks_until_recovery: number | null;
      blocks_until_inheritance: number | null;
      days_until_recovery: number | null;
      days_until_inheritance: number | null;
    }; fallback?: boolean }>('/governance', { method: 'POST', body: JSON.stringify({ action: 'status', ...body }) }).then(async r => {
      await keysForLists();
      return { ...r, vault_name: openVaultText(body.vault_id, F.vaultName, r.vault_name) as string };
    }),

    audit: (body: {
      vault_id: string;
      path: string;
      amount_sats: number;
      destination: string;
      utxo_age_blocks?: number;
      total_vault_sats?: number;
      signers?: { index: number; signed: boolean; label?: string }[];
    }) => req<{ ok: true; result: unknown }>('/governance', { method: 'POST', body: JSON.stringify({ action: 'audit', ...body }) }),
  },

  broadcast: (raw_tx_hex: string, network: Network) => {
    return fetch(broadcastTxUrl(network), {
      method: 'POST',
      body: raw_tx_hex,
      headers: { 'Content-Type': 'text/plain' },
    }).then(r => r.text());
  },

  proposals: {
    list: (vault_id: string) =>
      req<{ ok: true; proposals: Proposal[] }>(`/proposals?vault_id=${vault_id}`)
        .then(async r => { await keysForLists(); return { ...r, proposals: r.proposals.map(openProposal) }; }),

    create: (body: {
      vault_id: string;
      destination: string;
      amount_sats: number;
      path?: string;
      memo?: string;
      psbt_hex?: string;
      psbt_b64?: string;
      fee_sats?: number;
      /** Links this proposal back to the distribution-wallet tranche it
       *  claims (036_tranche_claim_proposals.sql). Omit for standard/Bloc
       *  spends -- both columns stay null. */
      distribution_wallet_id?: string;
      tranche_index?: number;
    }) => (async () => {
      const r = await req<{ ok: true; proposal: Proposal }>('/proposals', {
        method: 'POST',
        body: JSON.stringify({ ...body, memo: await seal(body.vault_id, F.proposalMemo, body.memo) }),
      });
      return { ...r, proposal: openProposal(r.proposal) };
    })(),

    update: (id: string, body: {
      status?: string;
      psbt_hex?: string;
      psbt_b64?: string;
      psbt_signed_hex?: string;
      txid?: string;
      memo?: string;
    }, vault_id?: string) => (async () => {
      const sealedBody = body.memo ? { ...body, memo: await seal(needVault(vault_id), F.proposalMemo, body.memo) } : body;
      const r = await req<{ ok: true; proposal: Proposal }>(`/proposals?id=${id}`, { method: 'PATCH', body: JSON.stringify(sealedBody) });
      return { ...r, proposal: openProposal(r.proposal) };
    })(),
  },

  liveness: {
    /** The vault's held signals plus its resolved liveness config
     *  (null = not liveness-gated), shaped for assembleLivenessGateInput. */
    get: (vault_id: string) =>
      req<{
        ok: true;
        proofs: Record<string, ProofOfLife | null | undefined>;
        redFlags: DuressFlag[];
        config: { circle: string[]; requiredGreenByPath: Record<string, number>; ttlSeconds: number } | null;
      }>(`/liveness?vault_id=${vault_id}`),
    /** Owner-only: clear a stuck duress flag for a subject so a single
     *  malicious or stale flag can't freeze signing forever. Never
     *  clears proof-of-life rows (those self-replace on a fresh
     *  heartbeat already). */
    clearDuress: (vault_id: string, subject: string) =>
      req<{ ok: true }>(`/liveness?vault_id=${vault_id}&subject=${subject}`, { method: 'DELETE' }),
  },


  auditPdfUrl: async (vault_id: string): Promise<string> => {
    const token = await getToken();
    return `/api/vault-audit-pdf?id=${vault_id}&token=${token}`;
  },

  activityExportUrl: async (vault_id: string): Promise<string> => {
    const token = await getToken();
    return `/api/vault-activity-export?vault_id=${vault_id}&token=${token}`;
  },

  taxSummaryUrl: async (vault_id: string, year: number): Promise<string> => {
    const token = await getToken();
    return `/api/vault-tax-summary?id=${vault_id}&year=${year}&token=${token}`;
  },

  pdfUrl: async (vault_id: string): Promise<string> => {
    const token = await getToken();
    return `/api/vault-pdf?id=${vault_id}&token=${token}`;
  },

  distributionWallets: {
    list: (vault_id: string) =>
      req<{ ok: true; wallets: DistributionWallet[] }>(`/distribution-wallets?vault_id=${vault_id}`)
        .then(async r => { await keysForLists(); return { ...r, wallets: r.wallets.map(openWallet) }; }),

    create: (body: {
      vault_id: string;
      name: string;
      beneficiary_name?: string;
      beneficiary_xpub: string;
      beneficiary_pubkey: string;
      trustee_keys: string[];
      trustee_quorum: number;
      network: 'testnet' | 'signet' | 'bitcoin';
      tranches: DistributionTranche[];
      key_origins?: { pubkey: string; fingerprint: string; derivation_path: string }[];
    }) =>
      (async () => {
        const r = await req<{ ok: true; wallet: DistributionWallet }>(`/distribution-wallets`, {
          method: 'POST',
          body: JSON.stringify({
            ...body,
            name: await seal(body.vault_id, F.walletName, body.name),
            beneficiary_name: await seal(body.vault_id, F.walletBeneficiary, body.beneficiary_name),
          }),
        });
        return { ...r, wallet: openWallet(r.wallet) };
      })(),

    /** name / beneficiary_name are sealed: pass the wallet's vault. */
    update: async (id: string, body: Partial<Pick<DistributionWallet, 'name' | 'beneficiary_name' | 'tranches'>>, vault_id?: string) => {
      const sealedBody = { ...body };
      if (body.name !== undefined) sealedBody.name = await seal(needVault(vault_id), F.walletName, body.name);
      if (body.beneficiary_name !== undefined) sealedBody.beneficiary_name = await seal(needVault(vault_id), F.walletBeneficiary, body.beneficiary_name);
      const r = await req<{ ok: true; wallet: DistributionWallet }>(`/distribution-wallets?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify(sealedBody),
      });
      return { ...r, wallet: openWallet(r.wallet) };
    },

    remove: (id: string) =>
      req<{ ok: true }>(`/distribution-wallets?id=${id}`, { method: 'DELETE' }),

    compileTranche: (body: {
      network: 'testnet' | 'signet' | 'bitcoin';
      beneficiary_key: string;
      trustee_keys: string[];
      trustee_quorum: number;
      unlock_block: number;
    }) =>
      req<{
        ok: true;
        network: string;
        miniscript_policy: string;
        descriptor: string;
        address: string;
        unlock_block: number;
      }>(`/compile-tranche`, { method: 'POST', body: JSON.stringify(body) }),

    // Build an unsigned PSBT spending one tranche -- the beneficiary
    // claiming it after its timelock, or a trustee via the escape
    // hatch. Policy params are looked up server-side from the
    // distribution_wallets row + the tranche itself, not supplied by
    // the caller, so a client cannot claim against an invented leaf.
    buildClaim: (body: {
      distribution_wallet_id: string;
      tranche_index: number;
      destination: string;
      amount_sats?: number;
      fee_rate?: number;
      path: 'beneficiary' | 'trustee';
      change_address?: string;
      key_origins?: { pubkey: string; fingerprint: string; derivation_path: string }[];
    }) =>
      req<{
        ok: true;
        psbt_hex: string;
        psbt_b64: string;
        summary: {
          amount_sats: number;
          fee_sats: number;
          change_sats: number;
          input_count: number;
          output_count: number;
          path: string;
          tranche_address: string;
        };
        status?: string;
        message?: string;
      }>(`/psbt-binary-tranche`, { method: 'POST', body: JSON.stringify(body) }),
  },

  stipends: {
    list: (vault_id: string) =>
      req<{ ok: true; stipends: ScheduledStipend[] }>(`/stipends?vault_id=${vault_id}`)
        .then(async r => { await keysForLists(); return { ...r, stipends: r.stipends.map(openStipend) }; }),

    create: (body: {
      vault_id: string;
      name: string;
      recipient_name?: string;
      destination?: string;
      rule_id?: string;
      amount_sats: number;
      interval_kind: StipendInterval;
      starts_at?: string;
    }) =>
      (async () => {
        const r = await req<{ ok: true; stipend: ScheduledStipend }>(`/stipends`, {
          method: 'POST',
          body: JSON.stringify({
            ...body,
            name: await seal(body.vault_id, F.stipendName, body.name),
            recipient_name: await seal(body.vault_id, F.stipendRecipient, body.recipient_name),
          }),
        });
        return { ...r, stipend: openStipend(r.stipend) };
      })(),

    /** name / recipient_name are sealed: pass the stipend's vault. */
    update: async (id: string, body: Partial<Pick<ScheduledStipend,
      'name' | 'recipient_name' | 'destination' | 'rule_id' |
      'amount_sats' | 'interval_kind' | 'next_due_at' |
      'last_proposed_at' | 'last_proposal_id' | 'active'
    >>, vault_id?: string) => {
      const sealedBody = { ...body };
      if (body.name !== undefined) sealedBody.name = await seal(needVault(vault_id), F.stipendName, body.name);
      if (body.recipient_name !== undefined) sealedBody.recipient_name = await seal(needVault(vault_id), F.stipendRecipient, body.recipient_name);
      const r = await req<{ ok: true; stipend: ScheduledStipend }>(`/stipends?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify(sealedBody),
      });
      return { ...r, stipend: openStipend(r.stipend) };
    },

    remove: (id: string) =>
      req<{ ok: true }>(`/stipends?id=${id}`, { method: 'DELETE' }),
  },

  vaultEvents: {
    list: (vault_id: string, limit = 50) =>
      req<{
        ok: true;
        events: {
          id: string;
          created_at: string;
          vault_id: string;
          user_id: string;
          event_type: string;
          metadata: Record<string, unknown>;
        }[];
      }>(`/vault-events?vault_id=${vault_id}&limit=${limit}`).then(async r => {
        // Names in the activity log were copied sealed from their rows.
        await keysForLists();
        return { ...r, events: r.events.map(e => ({ ...e, metadata: openSealedDeep(vault_id, e.metadata) as Record<string, unknown> })) };
      }),
  },

  // The vault's sealed record. `verification` and `anchoring` are the
  // SERVER's verdicts; the ledger page re-checks the raw rows itself
  // (lib/ledger-verify.ts) and treats these as a second opinion only.
  ledger: {
    get: (vault_id: string) =>
      req<{
        ok: true;
        entries: LedgerEntry[];
        anchors: LedgerAnchor[];
        verification: LedgerCheck;
        anchoring: AnchorCheck;
      }>(`/vault-ledger?vault_id=${vault_id}`),
  },

  vaultRequests: {
    list: (vault_id: string) =>
      req<{ ok: true; requests: VaultRequest[] }>(`/vault-requests?vault_id=${vault_id}`)
        .then(async r => { await keysForLists(); return { ...r, requests: r.requests.map(openRequest) }; }),

    create: (body: {
      vault_id: string;
      rule_id?: string;
      rule_name?: string;
      amount_sats: number;
      recipient_name?: string;
      reason?: string;
    }) =>
      (async () => {
        const v = body.vault_id;
        const r = await req<{ ok: true; request: VaultRequest }>(`/vault-requests`, {
          method: 'POST',
          body: JSON.stringify({
            ...body,
            rule_name: await seal(v, F.requestRuleName, body.rule_name),
            recipient_name: await seal(v, F.requestRecipient, body.recipient_name),
            reason: await seal(v, F.requestReason, body.reason),
          }),
        });
        return { ...r, request: openRequest(r.request) };
      })(),

    /** resolution_note is sealed: pass the request's vault. */
    update: async (
      id: string,
      body: {
        status?: VaultRequestStatus;
        resolution_note?: string;
        linked_proposal_id?: string;
      },
      vault_id?: string,
    ) => {
      const r = await req<{ ok: true; request: VaultRequest }>(`/vault-requests?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body.resolution_note
          ? { ...body, resolution_note: await seal(needVault(vault_id), F.requestNote, body.resolution_note) }
          : body),
      });
      return { ...r, request: openRequest(r.request) };
    },
  },

  vaultKeys: {
    get: (vault_id: string) =>
      req<VaultKeysState>(`/vault-keys?vault_id=${vault_id}`),
    post: (body: { vault_id: string; version: number; check?: string; wraps: { recipient_user_id: string; wrap: EncryptedMessage }[] }) =>
      req<{ ok: true; version: number }>(`/vault-keys`, { method: 'POST', body: JSON.stringify(body) }),
  },

  proposalComments: {
    list: (proposal_id: string) =>
      req<{ ok: true; comments: ProposalComment[] }>(`/proposal-comments?proposal_id=${proposal_id}`),

    create: (body: { proposal_id: string; body?: string; vote?: ProposalVote; sealed?: string }) =>
      req<{ ok: true; comment: ProposalComment }>(`/proposal-comments`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    remove: (id: string) =>
      req<{ ok: true }>(`/proposal-comments?id=${id}`, { method: 'DELETE' }),
  },

  signerSessions: {
    /** vault_id opens the sealed signer labels. */
    list: (proposal_id: string, vault_id?: string) =>
      req<{
        ok: true;
        sessions: {
          id: string;
          created_at: string;
          proposal_id: string;
          signer_index: number;
          signer_role: 'owner' | 'founder' | 'heir' | 'protector' | 'beneficiary';
          label: string | null;
          signed: boolean;
          signed_at: string | null;
          fingerprint: string | null;
          member_id: string | null;
          psbt_partial_hex: string | null;
        }[];
      }>(`/signer-sessions?proposal_id=${proposal_id}`)
        .then(async r => {
          if (!vault_id) return r;
          await keysForLists();
          return { ...r, sessions: r.sessions.map(ss => ({ ...ss, label: openSessionLabel(vault_id, ss.label) })) };
        }),

    /** label is sealed with the vault key: pass the proposal's vault. */
    submit: async (body: {
      proposal_id: string;
      psbt_partial_hex: string;
      fingerprint?: string;
      label?: string;
    }, vault_id?: string) =>
      req<{
        ok: true;
        session: {
          id: string;
          member_id: string | null;
          fingerprint: string | null;
          signed: boolean;
          signed_at: string | null;
          psbt_partial_hex: string | null;
        };
      }>(`/signer-sessions`, {
        method: 'POST',
        body: JSON.stringify(body.label ? { ...body, label: await seal(needVault(vault_id), F.signerLabel, body.label) } : body),
      }),
  },

  // Cross-vault pending proposals for the current member. Each row
  // includes a joined `vault` so the Dashboard can render labels
  // without a second fetch.
  proposalsMine: () =>
    req<{
      ok: true;
      proposals: (Proposal & {
        vault: {
          id: string;
          name: string;
          network: 'testnet' | 'signet' | 'bitcoin';
          founder_quorum: number;
          heir_quorum: number;
        };
        signer_sessions?: {
          id: string;
          signer_index: number;
          signer_role: 'owner' | 'founder' | 'heir' | 'protector' | 'beneficiary';
          label: string | null;
          signed: boolean;
          signed_at: string | null;
          fingerprint: string | null;
          member_id: string | null;
        }[];
      })[];
    }>(`/proposals-mine`).then(async r => {
      await keysForLists();
      return { ...r, proposals: r.proposals.map(openProposal) };
    }),

  members: {
    list: async (vault_id: string) => {
      const r = await req<{ ok: true; members: VaultMember[] }>(`/members?vault_id=${vault_id}`);
      await keysForLists();
      return { ...r, members: r.members.map(openMember) };
    },

    /** label / key_label are sealed, so the vault must be known: pass it. */
    update: async (
      id: string,
      body: Partial<Pick<VaultMember, 'label' | 'xpub' | 'fingerprint' | 'pubkey' | 'derivation_path' | 'key_label' | 'messaging_pubkey'>>,
      vault_id?: string,
    ) => {
      const sealedBody = { ...body };
      if (body.label !== undefined || body.key_label !== undefined) {
        const vid = needVault(vault_id);
        if (body.label !== undefined) sealedBody.label = await seal(vid, F.memberLabel, body.label);
        if (body.key_label !== undefined) sealedBody.key_label = await seal(vid, F.memberKeyLabel, body.key_label);
      }
      const r = await req<{ ok: true; member: VaultMember }>(`/members?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify(sealedBody),
      });
      return { ...r, member: openMember(r.member) };
    },

    /** Owner only: confirm a member's key after checking its fingerprint
     *  with them. The fingerprint is sent back so the confirmation is
     *  bound to the key the owner actually looked at. */
    confirmKey: (id: string, fingerprint: string) =>
      req<{ ok: true; member: VaultMember }>(`/members?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ confirm_key: true, fingerprint }),
      }),

    remove: (id: string) =>
      req<{ ok: true }>(`/members?id=${id}`, { method: 'DELETE' }),
  },

  invites: {
    list: (vault_id: string) =>
      req<{ ok: true; invites: VaultInvite[] }>(`/invites?vault_id=${vault_id}`)
        .then(async r => { await keysForLists(); return { ...r, invites: r.invites.map(openInvite) }; }),

    create: (body: {
      vault_id: string;
      /** Omit for a path invite: the server derives it from the path. */
      invited_role?: Exclude<VaultRole, 'owner'>;
      invited_label?: string;
      /** Path-builder vaults: invite one named person to hold one key on
       *  this path. Invites are link-only: no email is stored
       *  (docs/zero-knowledge-storage-plan.md decision 4). */
      leaf_id?: string;
      /** With leaf_id: the slot is one of the path's must-sign keys. */
      must_sign?: boolean;
    }) =>
      (async () => {
        const r = await req<{ ok: true; invite: VaultInvite }>(`/invites`, {
          method: 'POST',
          body: JSON.stringify({ ...body, invited_label: await seal(body.vault_id, F.memberLabel, body.invited_label) }),
        });
        return { ...r, invite: openInvite(r.invite) };
      })(),

    revoke: (id: string) =>
      req<{ ok: true }>(`/invites?id=${id}`, { method: 'DELETE' }),

    // Public lookup (no auth). Returns the invite + vault preview
    // (trust doc, quorums, timelocks, member roster) so a prospective
    // member can review before accepting.
    // Names arrive sealed (the invited person has no vault key yet); they are
    // replaced by what the invite link itself carried (lib/invite-link.ts).
    lookup: (token: string, hint: { vaultName?: string; label?: string } = {}) =>
      fetch(`/api/invites-lookup?token=${encodeURIComponent(token)}`).then(async r => {
        const body = (await r.json()) as {
          ok?: boolean;
          error?: string;
          invite?: {
            id: string;
            vault_id: string;
            invited_role: Exclude<VaultRole, 'owner'>;
            invited_label: string | null;
            expires_at: string;
            leaf_id?: string;
            must_sign?: boolean;
            email_hint?: string | null;
          } | null;
          vault?: {
            id: string;
            name: string;
            network: 'testnet' | 'signet' | 'bitcoin';
            status: string;
            address_type: string;
            founder_quorum: number;
            heir_quorum: number;
            recovery_quorum: number | null;
            recovery_after: number;
            inheritance_after: number;
            consent_quorum: number | null;
            trust_doc: TrustDoc;
            founder_count: number;
            heir_count: number;
            consent_count: number;
            planned_founder_count: number | null;
            planned_heir_count: number | null;
            is_leaf_list: boolean;
            paths: SpendingPathSummary[];
          } | null;
          members?: {
            id: string;
            role: VaultRole;
            label: string | null;
            status: string;
            created_at: string;
          }[];
        };
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        if (body.vault && isSealed(body.vault.name)) body.vault.name = hint.vaultName || 'a family vault';
        if (body.vault && (body.vault.trust_doc as { zk?: unknown } | null)?.zk) body.vault.trust_doc = {};
        if (body.invite && isSealed(body.invite.invited_label)) body.invite.invited_label = hint.label ?? null;
        if (body.members) body.members = body.members.map(m => (isSealed(m.label) ? { ...m, label: null } : m));
        return body as {
          ok: true;
          invite: NonNullable<typeof body.invite>;
          vault: NonNullable<typeof body.vault>;
          members: NonNullable<typeof body.members>;
        };
      }),

    claim: (body: {
      token: string;
      label?: string;
      xpub?: string;
      fingerprint?: string;
      pubkey?: string;
      derivation_path?: string;
      key_label?: string;
    }) =>
      (async () => {
        // The new member has no vault key yet, so their own label and key
        // label wait on this device (sealed-pending.ts) and are sealed the
        // first time the key reaches them. The server stores neither in the
        // clear; until then the inviter's (sealed) label names them.
        const { label, key_label, ...rest } = body;
        const r = await req<{ ok: true; member_id: string; vault_id: string }>(`/invites-claim`, {
          method: 'POST',
          body: JSON.stringify(rest),
        });
        if (label || key_label) savePending(r.vault_id, { ...(label ? { label } : {}), ...(key_label ? { key_label } : {}) });
        return r;
      })(),
  },

  messages: {
    list: (vault_id: string) =>
      req<{ ok: true; messages: VaultMessage[] }>(`/vault-messages?vault_id=${vault_id}`),

    send: (body: {
      vault_id: string;
      sender_pubkey: string;
      nonce: string;
      ciphertext: string;
      recipients: {
        user_id: string;
        pubkey: string;
        wrap_nonce: string;
        wrapped_key: string;
      }[];
      subject?: string | null;
      thread_id?: string | null;
    }) =>
      req<{ ok: true; message: VaultMessage }>(`/vault-messages`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  messagingKeyBackup: {
    get: () =>
      req<{
        ok: true;
        backup: {
          pubkey: string;
          wrapped_priv_b64: string;
          salt_b64: string;
          nonce_b64: string;
          updated_at: string;
        } | null;
      }>(`/messaging-key-backup`),

    save: (body: { pubkey: string; wrapped_priv_b64: string; salt_b64: string; nonce_b64: string }) =>
      req<{ ok: true; backup: unknown }>(`/messaging-key-backup`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
  },

  // "Secrets I've sent" recall (032_sent_secrets.sql) -- a password-
  // encrypted record of things like the circle safety phrase pair, so
  // the owner can look up what they told someone without it ever sitting
  // in plaintext anywhere.
  sentSecrets: {
    list: (vault_id: string) =>
      req<{ ok: true; secrets: SentSecret[] }>(`/sent-secrets?vault_id=${vault_id}`)
        .then(async r => { await keysForLists(); return { ...r, secrets: r.secrets.map(x => openSecret(x, vault_id)) }; }),

    create: (body: {
      vault_id: string;
      kind: string;
      label: string;
      recipients: { label: string; persona: string }[];
      blob: { ciphertextB64: string; saltB64: string; nonceB64: string };
    }) =>
      (async () => {
        const v = body.vault_id;
        const recipients = [];
        for (const rcp of body.recipients) recipients.push({ ...rcp, label: (await seal(v, F.secretRecipient, rcp.label)) as string });
        const r = await req<{ ok: true; secret: SentSecret }>(`/sent-secrets`, {
          method: 'POST',
          body: JSON.stringify({ ...body, label: await seal(v, F.secretLabel, body.label), recipients }),
        });
        return { ...r, secret: openSecret(r.secret, v) };
      })(),

    remove: (id: string) =>
      req<{ ok: true }>(`/sent-secrets?id=${id}`, { method: 'DELETE' }),
  },

  // "Circle membership" persisted grant + accept/decline roster
  // (033_vault_membership_grants.sql). Send-side of VaultMembershipSetup
  // upserts a grant per (vault, role, key) it sends to; the ack channel
  // PATCHes status when the member's wallet responds.
  vaultMembershipGrants: {
    list: (vault_id: string) =>
      req<{ ok: true; grants: VaultMembershipGrant[] }>(`/vault-membership-grants?vault_id=${vault_id}`),

    create: (body: {
      vault_id: string;
      role: string;
      key_id: string;
      recipient_label: string;
      recipient_persona: string;
      recipient_pubkey: string;
      request_event_id: string | null;
      reply_pubkey: string;
      reply_privkey_sealed: EncryptedMessage;
    }) =>
      req<{ ok: true; grant: VaultMembershipGrant }>(`/vault-membership-grants`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    updateStatus: (id: string, status: 'accepted' | 'declined' | 'left') =>
      req<{ ok: true; grant: VaultMembershipGrant }>(`/vault-membership-grants?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
  },

  // Persisted send-status for the circle safety phrase pair
  // (034_circle_phrase_deliveries.sql) -- never the phrase text itself.
  circlePhraseDeliveries: {
    list: (vault_id: string) =>
      req<{ ok: true; deliveries: CirclePhraseDelivery[] }>(`/circle-phrase-deliveries?vault_id=${vault_id}`),

    upsert: (body: {
      vault_id: string;
      recipient_key_id: string;
      recipient_label: string;
      recipient_persona: string;
      status: 'delivered' | 'queued';
      reply_pubkey?: string;
      reply_privkey_sealed?: EncryptedMessage;
    }) =>
      req<{ ok: true; delivery: CirclePhraseDelivery }>(`/circle-phrase-deliveries`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    /** Record a real receipt ack from the recipient's Tapit wallet
     *  (circle-phrase-ack-channel.ts calls this on a verified, decrypted
     *  ack -- never on the relay-publish outcome alone). */
    confirm: (reply_pubkey: string) =>
      req<{ ok: true; delivery: CirclePhraseDelivery }>(`/circle-phrase-deliveries`, {
        method: 'PATCH',
        body: JSON.stringify({ reply_pubkey }),
      }),
  },

  /** The Tapit wallet bound to the current account, if any -- read side of
   *  wallet-link.js's POST binding (2026-08-19, operator: "not showing back
   *  up in dynasty and frankly no where for it to be"). */
  walletLink: {
    get: () =>
      req<{ ok: true; pubkey: string | null; bound_at: string | null }>(`/wallet-link`),
    unlink: () =>
      req<{ ok: true }>(`/wallet-link`, { method: 'DELETE' }),
  },

  attestations: {
    list: (vault_id: string, type?: AttestationType) => {
      const qs = type ? `&type=${type}` : '';
      return req<{ ok: true; attestations: VaultAttestation[] }>(
        `/vault-attestations?vault_id=${vault_id}${qs}`,
      ).then(async r => { await keysForLists(); return { ...r, attestations: r.attestations.map(openAttestation) }; });
    },

    create: (body: {
      vault_id: string;
      attestation_type: AttestationType;
      target_hash: string;
      target_data?: Record<string, unknown>;
      signature: string;
      pubkey: string;
    }) =>
      (async () => {
        // target_data (a trust-document snapshot, a declaration's notes) is
        // sealed; target_hash and the signature stay public so the server
        // can still check the signature.
        const target_data = body.target_data && Object.keys(body.target_data).length > 0
          ? await sealJson(body.vault_id, F.attestationData, body.target_data)
          : body.target_data;
        const r = await req<{ ok: true; attestation: VaultAttestation }>(`/vault-attestations`, {
          method: 'POST',
          body: JSON.stringify({ ...body, target_data }),
        });
        return { ...r, attestation: openAttestation(r.attestation) };
      })(),

    remove: (id: string) =>
      req<{ ok: true }>(`/vault-attestations?id=${id}`, { method: 'DELETE' }),
  },

  // Education bot ("Sage") -- slice 1. A guided Q&A that teaches a
  // newcomer and proposes ONE vault for tap-to-confirm. The reply's
  // optional `proposed_values` is rendered as a confirm card; the
  // actual vault is built only through the existing PolicyBuilder.
  // No key material is ever sent here or returned.
  assistant: {
    chat: (body: {
      thread_id: string | null;
      message: string;
      mode: 'guided' | 'express';
      vault_id?: string;
    }) =>
      req<{
        ok: true;
        thread: { id: string; mode: 'guided' | 'express'; vault_id: string | null };
        reply: string;
        proposed_values: VaultProposal | null;
      }>('/assistant', { method: 'POST', body: JSON.stringify(body) }),
  },

  health: () => fetch('/api/health').then(r => r.json()),
};

// A structured vault recommendation from the education bot. The
// PolicyBuilder is the only place a vault is actually compiled + saved;
// this is a proposal the user confirms with a tap. No key material.
export interface VaultProposal {
  template: string;
  founder_quorum: number;
  founder_count: number;
  heir_quorum: number;
  heir_count: number;
  recovery_after_months: number;
  inheritance_after_months: number;
  // Optional deeper backstop tier -- present only when Sage's plan
  // actually includes one (see assistant.js's SECOND INHERITANCE
  // section). second_inheritance_after_months is always greater than
  // inheritance_after_months when set.
  second_heir_quorum?: number;
  second_heir_count?: number;
  second_inheritance_after_months?: number;
  summary: string;
}
