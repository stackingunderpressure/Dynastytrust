import { supabase } from './supabase';
import { broadcastTxUrl, type Network } from '../config';

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

export interface Proposal {
  id: string;
  created_at: string;
  vault_id: string;
  path: 'founders_now' | 'recovery' | 'inheritance';
  destination: string;
  amount_sats: number;
  fee_sats: number;
  status: 'draft' | 'pending' | 'signed' | 'broadcast' | 'cancelled';
  psbt_hex?: string;
  psbt_b64?: string;
  txid?: string;
  memo?: string;
  governance_audit?: unknown;
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
    }) =>
      req<{ ok: true; vault: Vault }>('/vaults', {
        method: 'POST',
        body: JSON.stringify({ ...body, mode: 'draft' }),
      }),

    compile: (vault_id: string) =>
      req<{ ok: true; vault: Vault }>('/vaults-compile', {
        method: 'POST',
        body: JSON.stringify({ vault_id }),
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

    updateTrustDoc: (id: string, trust_doc: TrustDoc) =>
      req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ trust_doc }),
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


  psbt: {
    generate: (body: {
      vault_id: string;
      destination: string;
      amount_sats: number;
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
      // Readiness "eyes" -- COUNTS and public labels ONLY. The client
      // assembles this from the local keystore (counts, never key
      // material) and the vault list (name/template/network labels).
      // The server re-sanitizes it against a strict allow-list before
      // it reaches the model. NEVER put an xpub, pubkey, mnemonic, or
      // any secret in here.
      eyes?: AssistantEyes;
    }) =>
      req<{
        ok: true;
        thread: { id: string; mode: 'guided' | 'express'; vault_id: string | null };
        reply: string;
        proposed_values: VaultProposal | null;
        // Optional model-emitted contextual next-step chips: 3-5 short,
        // tap-able strings the UI renders beneath the reply. Extracted
        // and validated server-side; absent or [] when none. No secrets.
        chips: string[] | null;
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

// Readiness "eyes" the client ships so Sage can ground guidance in the
// person's real, SAFE setup state. COUNTS and public LABELS ONLY -- this
// type has NO field for a private key, mnemonic, xpub, pubkey, password,
// or any secret, and the server re-sanitizes it against an allow-list
// before it reaches the model. Assembled in ChatWizard from the keystore
// (counts) and the vault list (name/template/network labels).
export interface AssistantEyes {
  keys: {
    key_count: number;
    secure_key_count: number;
    test_key_count: number;
    backed_up_key_count: number;
  };
  vault_count: number;
  vaults: {
    name: string;
    template: string | null;
    network: 'testnet' | 'signet' | 'bitcoin';
  }[];
}
