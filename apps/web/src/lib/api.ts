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

export interface Vault {
  id: string;
  created_at: string;
  updated_at: string;
  user_id: string;
  name: string;
  network: 'testnet' | 'bitcoin';
  address: string;
  descriptor: string;
  miniscript_policy: string;
  address_type: 'wsh' | 'tr' | 'tr_multileaf';
  founder_quorum: number;
  heir_quorum: number;
  recovery_after: number;
  inheritance_after: number;
  founder_keys: string[];
  heir_keys: string[];
  archived: boolean;
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

export type VaultRole = 'owner' | 'founder' | 'heir' | 'viewer';
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
  key_label: string | null;
  status: VaultMemberStatus;
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
      network: 'testnet' | 'bitcoin';
      address: string;
      descriptor: string;
      miniscript_policy: string;
      address_type?: string;
      founder_quorum?: number;
      heir_quorum?: number;
      recovery_after?: number;
      inheritance_after?: number;
      founder_keys?: string[];
      heir_keys?: string[];
    }) => req<{ ok: true; vault: Vault }>('/vaults', { method: 'POST', body: JSON.stringify(body) }),

    archive: (id: string) =>
      req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: true }),
      }),

    rename: (id: string, name: string) =>
      req<{ ok: true; vault: Vault }>(`/vaults?id=${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
  },

  balance: (address: string, network: 'testnet' | 'bitcoin') =>
    req<BalanceResult>(`/balance?address=${encodeURIComponent(address)}&network=${network}`),

  compile: (body: {
    name: string;
    network: 'testnet' | 'bitcoin';
    address_type?: string;
    founder_keys: string[];
    founder_quorum: number;
    heir_keys: string[];
    heir_quorum: number;
    recovery_after: number;
    inheritance_after: number;
    save?: boolean;
  }) => req<{ ok: true; compiled: unknown; saved: boolean; vault?: Vault }>('/compile', {
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


  pdfUrl: async (vault_id: string): Promise<string> => {
    const token = await getToken();
    return `/api/vault-pdf?id=${vault_id}&token=${token}`;
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
          network: 'testnet' | 'bitcoin';
          founder_quorum: number;
          heir_quorum: number;
        };
      })[];
    }>(`/proposals-mine`),

  members: {
    list: (vault_id: string) =>
      req<{ ok: true; members: VaultMember[] }>(`/members?vault_id=${vault_id}`),

    update: (
      id: string,
      body: Partial<Pick<VaultMember, 'label' | 'xpub' | 'fingerprint' | 'key_label'>>,
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

    // Public lookup (no auth). Returns only the fields the claim page needs.
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
          vault?: { id: string; name: string; network: 'testnet' | 'bitcoin' } | null;
        };
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        return body as { ok: true; invite: NonNullable<typeof body.invite>; vault: typeof body.vault };
      }),

    claim: (body: {
      token: string;
      label?: string;
      xpub?: string;
      fingerprint?: string;
      key_label?: string;
    }) =>
      req<{ ok: true; member_id: string; vault_id: string }>(`/invites-claim`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  health: () => fetch('/api/health').then(r => r.json()),
};
