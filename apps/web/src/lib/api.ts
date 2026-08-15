import { supabase } from './supabase';
import { broadcastTxUrl, type Network } from '../config';
import type { ProofOfLife, DuressFlag } from 'tapit-attest';

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
  /** Protector branch: optional fourth path in the Taproot tree.
   *  Empty = not configured. */
  protector_keys: string[];
  protector_quorum: number | null;
  protector_after: number | null;
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
   *  "recovery" OR "backup" -- mutually exclusive, "inheritance",
   *  "protector"), populated by the compiler
   *  for a tr_multileaf vault only (026_leaf_scripts.sql). This is the
   *  source data for minting a vault-membership attestation (Cut C3,
   *  circle-membership-delivery.ts) -- what proves to a Tapit circle
   *  member's wallet which exact leaf its key appears in, so a later
   *  psbt-cosign request can be checked against a leaf the wallet was
   *  actually told about at vault-creation time. Null for non-multileaf
   *  address types and Bloc vaults. */
  leaf_scripts: Record<string, string> | null;
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
  reply_privkey: string;
  status: 'sent' | 'accepted' | 'declined';
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
}

/** One signer's row on a proposal -- who's been asked to sign and whether
 *  they have. Embedded on every Proposal returned by GET /proposals
 *  (proposals.js's select already joins signer_sessions); this type just
 *  names the shape so the UI can render it. */
export interface ProposalSignerSession {
  id: string;
  signer_index: number;
  signer_role: 'founder' | 'heir' | string;
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
    | 'tranche_claim';
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
  token: string;
  expires_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
}

//

export const api = {
  vaults: {
    list: (showArchived = false) =>
      req<{ ok: true; vaults: Vault[] }>(`/vaults${showArchived ? '?archived=true' : ''}`),

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
      protector_keys?: string[];
      protector_quorum?: number | null;
      protector_after?: number | null;
      consent_keys?: string[];
      consent_quorum?: number | null;
      /** TOS version the user accepted. Server writes a
       *  terms_accepted vault_event with this string + timestamp. */
      terms_accepted_version?: string;
    }) => req<{ ok: true; vault: Vault }>('/vaults', { method: 'POST', body: JSON.stringify(body) }),

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
    }) => req<{ ok: true; vault: Vault }>('/vaults', {
      method: 'POST',
      body: JSON.stringify({ ...body, mode: 'bloc' }),
    }),

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
    }) => req<{ ok: true; vault: Vault }>('/vaults', {
      method: 'POST',
      body: JSON.stringify({ ...body, mode: 'bloc-draft' }),
    }),

    // Compiles a draft Bloc vault (created via createBlocDraft) into a
    // live, spendable one, once every parent/kid slot has a real key.
    compileBloc: (body: {
      vault_id: string;
      parent_keys: string[];
      kid_keys: string[];
      parent_xpubs: string[];
      kid_xpubs: string[];
      key_origins: { pubkey: string; fingerprint: string; derivation_path: string }[];
    }) => req<{ ok: true; vault: Vault }>('/vaults-compile-bloc', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

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
      protector_quorum?: number | null;
      protector_after?: number | null;
      consent_quorum?: number | null;
      backup_quorum?: number | null;
      second_heir_quorum?: number | null;
      second_inheritance_after?: number | null;
    }) =>
      req<{ ok: true; vault: Vault }>('/vaults', {
        method: 'POST',
        body: JSON.stringify({ ...body, mode: 'draft' }),
      }),

    // direct_keys: the SAME owner brings every key themselves (no
    // invite/vault_members involvement) -- for finishing a draft vault
    // whose Configure step ran before every key slot was filled.
    // Omit for the invite-based flow (members bring their own xpub via
    // a claim link).
    compile: (vault_id: string, direct_keys?: {
      founder_keys?: { pubkey: string; xpub: string; fingerprint: string; derivation_path: string }[];
      heir_keys?: { pubkey: string; xpub: string; fingerprint: string; derivation_path: string }[];
      protector_keys?: { pubkey: string; xpub: string; fingerprint: string; derivation_path: string }[];
      consent_keys?: { pubkey: string; xpub: string; fingerprint: string; derivation_path: string }[];
      backup_keys?: { pubkey: string; xpub: string; fingerprint: string; derivation_path: string }[];
      second_heir_keys?: { pubkey: string; xpub: string; fingerprint: string; derivation_path: string }[];
    }) =>
      req<{ ok: true; vault: Vault }>('/vaults-compile', {
        method: 'POST',
        body: JSON.stringify(direct_keys ? { vault_id, direct_keys } : { vault_id }),
      }),

    archive: (id: string) =>
      req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: true }),
      }),

    remove: (id: string) =>
      req<{ ok: true }>(`/vaults?id=${id}`, { method: 'DELETE' }),

    rotate: (body: {
      vault_id: string;
      overrides?: {
        name?: string;
        recovery_after?: number;
        inheritance_after?: number;
        protector_after?: number;
        founder_quorum?: number;
        heir_quorum?: number;
        recovery_quorum?: number | null;
      };
    }) =>
      req<{ ok: true; vault: Vault }>(`/vaults-rotate`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    rename: (id: string, name: string) =>
      req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),

    // Draft-only server-side (netlify/functions/vaults.js rejects this once
    // status is "compiled" -- the address/descriptor are already derived
    // FOR the old network by then, and swapping the label afterward would
    // silently point at the wrong chain). Lets VaultWizard's Keys step fix
    // a vault that landed on the wrong network before any keys are added.
    updateNetwork: (id: string, network: 'testnet' | 'signet' | 'bitcoin') =>
      req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ network }),
      }),

    updateTrustDoc: (id: string, trust_doc: TrustDoc) =>
      req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ trust_doc }),
      }),

    // The plain, one-tap halt: true blocks every signing path on this vault
    // immediately (evaluateSigningGate's fail-closed duress check, already
    // enforced at sign time -- see VaultDetail's signing flow). false lifts
    // it. No phrase, no per-signer targeting -- for when a member can act
    // freely and just needs to stop everything right now.
    setDuress: (id: string, duress: boolean) =>
      req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ duress }),
      }),
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
    protector_keys?: string[];
    protector_quorum?: number | null;
    protector_after?: number | null;
    consent_keys?: string[];
    consent_quorum?: number | null;
    save?: boolean;
  }) => req<{
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
      protector_after: number;
      tip_height: number;
    };
  }>('/compile', {
    method: 'POST',
    body: JSON.stringify(body),
  }),

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
    // Persisted vault (recommended): the server looks up address + the
    // whole policy (including key_origins) from the vaults row -- pass
    // just this and destination/amount/path. Omit the raw-policy fields
    // below entirely.
    vault_id?: string;
    // Un-persisted / legacy form: caller supplies the whole policy
    // directly, same as before Bloc vaults were saveable.
    address?: string;
    network?: 'testnet' | 'signet' | 'bitcoin';
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
    parent_keys?: string[];
    kid_keys?: string[];
    parents_together_quorum?: number;
    coparent_quorum?: number;
    kids_with_parent_quorum?: number;
    parent_solo_quorum?: number;
    kids_decay_start_quorum?: number;
    kids_decay_floor_quorum?: number;
    // ABSOLUTE block heights.
    parent_solo_after?: number;
    kids_decay_start_after?: number;
    kids_decay_step_blocks?: number;
    // BIP32 origins for hardware-wallet compatibility (2026-08-06 fix) --
    // optional; omitting it degrades to pre-fix behavior (no
    // tap_key_origins attached, so only the browser/Tapit signers work).
    // Ignored when vault_id is given -- comes from the stored policy.
    key_origins?: { pubkey: string; fingerprint: string; derivation_path: string }[];
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
    }>('/psbt-binary', { method: 'POST', body: JSON.stringify(body) }),

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
    }; fallback?: boolean }>('/governance', { method: 'POST', body: JSON.stringify({ action: 'status', ...body }) }),

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
      req<{ ok: true; proposals: Proposal[] }>(`/proposals?vault_id=${vault_id}`),

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
    }) => req<{ ok: true; proposal: Proposal }>('/proposals', { method: 'POST', body: JSON.stringify(body) }),

    update: (id: string, body: {
      status?: string;
      psbt_hex?: string;
      psbt_b64?: string;
      psbt_signed_hex?: string;
      txid?: string;
      memo?: string;
    }) => req<{ ok: true; proposal: Proposal }>(`/proposals?id=${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
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
      req<{ ok: true; wallets: DistributionWallet[] }>(`/distribution-wallets?vault_id=${vault_id}`),

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
      req<{ ok: true; wallet: DistributionWallet }>(`/distribution-wallets`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    update: (id: string, body: Partial<Pick<DistributionWallet, 'name' | 'beneficiary_name' | 'tranches'>>) =>
      req<{ ok: true; wallet: DistributionWallet }>(`/distribution-wallets?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

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
      req<{ ok: true; stipends: ScheduledStipend[] }>(`/stipends?vault_id=${vault_id}`),

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
      req<{ ok: true; stipend: ScheduledStipend }>(`/stipends`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    update: (id: string, body: Partial<Pick<ScheduledStipend,
      'name' | 'recipient_name' | 'destination' | 'rule_id' |
      'amount_sats' | 'interval_kind' | 'next_due_at' |
      'last_proposed_at' | 'last_proposal_id' | 'active'
    >>) =>
      req<{ ok: true; stipend: ScheduledStipend }>(`/stipends?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

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
      }>(`/vault-events?vault_id=${vault_id}&limit=${limit}`),
  },

  vaultRequests: {
    list: (vault_id: string) =>
      req<{ ok: true; requests: VaultRequest[] }>(`/vault-requests?vault_id=${vault_id}`),

    create: (body: {
      vault_id: string;
      rule_id?: string;
      rule_name?: string;
      amount_sats: number;
      recipient_name?: string;
      reason?: string;
    }) =>
      req<{ ok: true; request: VaultRequest }>(`/vault-requests`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    update: (
      id: string,
      body: {
        status?: VaultRequestStatus;
        resolution_note?: string;
        linked_proposal_id?: string;
      },
    ) =>
      req<{ ok: true; request: VaultRequest }>(`/vault-requests?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  },

  proposalComments: {
    list: (proposal_id: string) =>
      req<{ ok: true; comments: ProposalComment[] }>(`/proposal-comments?proposal_id=${proposal_id}`),

    create: (body: { proposal_id: string; body?: string; vote?: ProposalVote }) =>
      req<{ ok: true; comment: ProposalComment }>(`/proposal-comments`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    remove: (id: string) =>
      req<{ ok: true }>(`/proposal-comments?id=${id}`, { method: 'DELETE' }),
  },

  signerSessions: {
    list: (proposal_id: string) =>
      req<{
        ok: true;
        sessions: {
          id: string;
          created_at: string;
          proposal_id: string;
          signer_index: number;
          signer_role: 'founder' | 'heir';
          label: string | null;
          signed: boolean;
          signed_at: string | null;
          fingerprint: string | null;
          member_id: string | null;
          psbt_partial_hex: string | null;
        }[];
      }>(`/signer-sessions?proposal_id=${proposal_id}`),

    submit: (body: {
      proposal_id: string;
      psbt_partial_hex: string;
      fingerprint?: string;
      label?: string;
    }) =>
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
      }>(`/signer-sessions`, { method: 'POST', body: JSON.stringify(body) }),
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
          signer_role: 'founder' | 'heir';
          label: string | null;
          signed: boolean;
          signed_at: string | null;
          fingerprint: string | null;
          member_id: string | null;
        }[];
      })[];
    }>(`/proposals-mine`),

  members: {
    list: (vault_id: string) =>
      req<{ ok: true; members: VaultMember[] }>(`/members?vault_id=${vault_id}`),

    update: (
      id: string,
      body: Partial<Pick<VaultMember, 'label' | 'xpub' | 'fingerprint' | 'pubkey' | 'derivation_path' | 'key_label' | 'messaging_pubkey'>>,
    ) =>
      req<{ ok: true; member: VaultMember }>(`/members?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    remove: (id: string) =>
      req<{ ok: true }>(`/members?id=${id}`, { method: 'DELETE' }),
  },

  invites: {
    list: (vault_id: string) =>
      req<{ ok: true; invites: VaultInvite[] }>(`/invites?vault_id=${vault_id}`),

    create: (body: {
      vault_id: string;
      invited_role: Exclude<VaultRole, 'owner'>;
      invited_label?: string;
      invited_email?: string;
    }) =>
      req<{ ok: true; invite: VaultInvite }>(`/invites`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    revoke: (id: string) =>
      req<{ ok: true }>(`/invites?id=${id}`, { method: 'DELETE' }),

    // Public lookup (no auth). Returns the invite + vault preview
    // (trust doc, quorums, timelocks, member roster) so a prospective
    // member can review before accepting.
    lookup: (token: string) =>
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
            protector_quorum: number | null;
            protector_after: number | null;
            consent_quorum: number | null;
            trust_doc: TrustDoc;
            founder_count: number;
            heir_count: number;
            protector_count: number;
            consent_count: number;
            planned_founder_count: number | null;
            planned_heir_count: number | null;
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
      req<{ ok: true; member_id: string; vault_id: string }>(`/invites-claim`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
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
      req<{ ok: true; secrets: SentSecret[] }>(`/sent-secrets?vault_id=${vault_id}`),

    create: (body: {
      vault_id: string;
      kind: string;
      label: string;
      recipients: { label: string; persona: string }[];
      blob: { ciphertextB64: string; saltB64: string; nonceB64: string };
    }) =>
      req<{ ok: true; secret: SentSecret }>(`/sent-secrets`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

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
      reply_privkey: string;
    }) =>
      req<{ ok: true; grant: VaultMembershipGrant }>(`/vault-membership-grants`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    updateStatus: (id: string, status: 'accepted' | 'declined') =>
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
      reply_privkey?: string;
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

  attestations: {
    list: (vault_id: string, type?: AttestationType) => {
      const qs = type ? `&type=${type}` : '';
      return req<{ ok: true; attestations: VaultAttestation[] }>(
        `/vault-attestations?vault_id=${vault_id}${qs}`,
      );
    },

    create: (body: {
      vault_id: string;
      attestation_type: AttestationType;
      target_hash: string;
      target_data?: Record<string, unknown>;
      signature: string;
      pubkey: string;
    }) =>
      req<{ ok: true; attestation: VaultAttestation }>(`/vault-attestations`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

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
  summary: string;
}
