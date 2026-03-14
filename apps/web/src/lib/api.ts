import { supabase } from './supabase';

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
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error ?? `Request failed: ${res.status}`);
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

  proposals: {
    list: (vault_id: string) =>
      req<{ ok: true; proposals: Proposal[] }>(`/proposals?vault_id=${vault_id}`),

    create: (body: {
      vault_id: string;
      destination: string;
      amount_sats: number;
      path?: string;
      memo?: string;
    }) => req<{ ok: true; proposal: Proposal }>('/proposals', { method: 'POST', body: JSON.stringify(body) }),
  },

  pdfUrl: async (vault_id: string): Promise<string> => {
    const token = await getToken();
    return `/api/vault-pdf?id=${vault_id}&token=${token}`;
  },

  health: () => fetch('/api/health').then(r => r.json()),
};
