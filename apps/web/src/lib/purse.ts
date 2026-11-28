/**
 * purse.ts -- the family purse's browser-side checks (slice 2).
 *
 * payoutTargetText / payoutTargetHash: the exact bytes a member's yes
 * signs. MUST match netlify/functions/_purse.js payoutTargetText, which the
 * server recomputes from the stored row; scripts/test-vault-purse.mjs
 * checks the two agree.
 *
 * readInvoice: just enough of a BOLT11 Lightning invoice to refuse the
 * wrong one before anyone signs -- the bech32 checksum, the network
 * prefix, and the amount. It does NOT read the payee, the expiry or the
 * description, and it does not prove the invoice is payable; the
 * treasurer's wallet does that when it pays (slice 3).
 */
import { bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import type { Vault } from './api';

export const YES_TYPE = 'purse_payout_yes' as const;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function sha256Hex(text: string): string {
  return toHex(sha256(new TextEncoder().encode(text)));
}

export function payoutTargetText(p: {
  vault_id: string;
  request_id: string;
  amount_sats: number;
  road: string;
  invoice_sha256: string | null;
}): string {
  return ['DT-PURSE-v1', p.vault_id, p.request_id, String(p.amount_sats), p.road, p.invoice_sha256 ?? ''].join('|');
}

export function payoutTargetHash(p: Parameters<typeof payoutTargetText>[0]): string {
  return sha256Hex(payoutTargetText(p));
}

/** Longest prefix first: lntbs before lntb, lnbcrt before lnbc. */
const PREFIXES: { prefix: string; network: Vault['network'] | 'regtest' }[] = [
  { prefix: 'lnbcrt', network: 'regtest' },
  { prefix: 'lntbs', network: 'signet' },
  { prefix: 'lntb', network: 'testnet' },
  { prefix: 'lnbc', network: 'bitcoin' },
];

/** millisats per unit of amount, by BOLT11 multiplier. */
const MSAT_PER: Record<string, bigint> = { m: 100000000n, u: 100000n, n: 100n };

export type InvoiceRead =
  | { ok: true; invoice: string; network: string; amount_sats: number; sha256: string }
  | { ok: false; error: string };

export function readInvoice(raw: string, network: Vault['network']): InvoiceRead {
  let inv = raw.trim();
  if (inv.toLowerCase().startsWith('lightning:')) inv = inv.slice('lightning:'.length);
  inv = inv.toLowerCase();
  if (!inv.startsWith('ln')) return { ok: false, error: 'That is not a Lightning invoice. It should start with lnbc.' };
  let hrp: string;
  try {
    hrp = bech32.decode(inv as `${string}1${string}`, false).prefix;
  } catch {
    return { ok: false, error: 'That invoice did not copy whole: its check letters do not add up.' };
  }
  const found = PREFIXES.find(x => hrp.startsWith(x.prefix));
  if (!found) return { ok: false, error: 'That invoice is for a network this app does not know.' };
  if (found.network !== network) {
    return { ok: false, error: `That invoice is for ${found.network}, but this vault is on ${network}.` };
  }
  const amt = hrp.slice(found.prefix.length);
  if (!amt) return { ok: false, error: 'That invoice has no amount. Ask for one with the exact amount in it, so every yes is for that amount.' };
  const m = /^([0-9]+)([munp]?)$/.exec(amt);
  if (!m || m[1].startsWith('0')) return { ok: false, error: 'Could not read the amount in that invoice.' };
  const n = BigInt(m[1]);
  let msat: bigint;
  if (m[2] === 'p') {
    if (n % 10n !== 0n) return { ok: false, error: 'Could not read the amount in that invoice.' };
    msat = n / 10n;
  } else if (m[2] === '') {
    msat = n * 100000000000n;
  } else {
    msat = n * MSAT_PER[m[2]];
  }
  if (msat % 1000n !== 0n) return { ok: false, error: 'That invoice asks for a part of a sat. Ask for a whole number of sats.' };
  const sats = msat / 1000n;
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: 'That invoice amount is far too large.' };
  return { ok: true, invoice: inv, network: found.network, amount_sats: Number(sats), sha256: sha256Hex(inv) };
}
