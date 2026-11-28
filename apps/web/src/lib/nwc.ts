/**
 * nwc.ts -- pay one Lightning invoice through Nostr Wallet Connect
 * (NIP-47), for the family purse's treasurer (slice 3).
 *
 * The connection string (nostr+walletconnect://...) is a spending key for
 * the family's wallet, up to the budget set in that wallet. It lives only
 * on the treasurer's phone, encrypted with their password
 * (lib/nwc-store.ts); it never reaches the server.
 *
 * Encryption: the wallet's info event (kind 13194) says which it speaks.
 * nip44_v2 when offered; otherwise NIP-04, which NIP-47 says to assume
 * when a wallet advertises nothing.
 *
 * Outcomes are three, on purpose:
 *  - paid: the wallet handed back a preimage whose sha256 IS the invoice's
 *    payment hash. Only then.
 *  - failed: the wallet said a definite no (no balance, over its budget,
 *    not allowed, payment failed). Nothing left the wallet.
 *  - unknown: no answer in time, an unclear error, or a preimage that does
 *    not match. The money may or may not have moved. Trying again is safe:
 *    a Lightning invoice can be paid only once.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { cbc } from '@noble/ciphers/aes.js';
import { buildEvent, NostrTransport, verifyEvent, type TransportEvent, type TransportFilter } from '@dynastytrust/nostr-transport';
import { decryptFrom, encryptTo } from '@dynastytrust/nip44';
import { receiptMatches } from './purse';

export const NWC_INFO_KIND = 13194;
export const NWC_REQUEST_KIND = 23194;
export const NWC_RESPONSE_KIND = 23195;

export interface NwcConnection {
  walletPubkey: string;
  relays: string[];
  secret: string;
  clientPubkey: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function toHex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}
function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function b64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function parseNwcUri(raw: string): { ok: true; conn: NwcConnection } | { ok: false; error: string } {
  const s = raw.trim();
  const m = /^nostr\+walletconnect:\/\/([0-9a-fA-F]{64})\?(.+)$/.exec(s);
  if (!m) return { ok: false, error: 'That is not a wallet connection. It should start with nostr+walletconnect://' };
  const params = new URLSearchParams(m[2]);
  const relays = params.getAll('relay').map(r => r.trim()).filter(r => /^wss:\/\/[^\s]+$/.test(r));
  const secret = (params.get('secret') ?? '').toLowerCase();
  if (!relays.length) return { ok: false, error: 'That connection names no secure relay (wss://).' };
  if (!HEX64.test(secret)) return { ok: false, error: 'That connection has no valid secret in it. Copy it again from the wallet.' };
  let clientPubkey: string;
  try {
    clientPubkey = toHex(schnorr.getPublicKey(fromHex(secret)));
  } catch {
    return { ok: false, error: 'That connection secret is not a valid key.' };
  }
  return { ok: true, conn: { walletPubkey: m[1].toLowerCase(), relays, secret, clientPubkey } };
}

function nip04Key(privHex: string, pubHex: string): Uint8Array {
  return secp256k1.getSharedSecret(fromHex(privHex), fromHex('02' + pubHex)).slice(1, 33);
}

export function nip04Encrypt(text: string, pubHex: string, privHex: string): string {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ct = cbc(nip04Key(privHex, pubHex), iv).encrypt(new TextEncoder().encode(text));
  return `${b64(ct)}?iv=${b64(iv)}`;
}

export function nip04Decrypt(payload: string, pubHex: string, privHex: string): string {
  const [ct, iv] = payload.split('?iv=');
  if (!ct || !iv) throw new Error('not a NIP-04 payload');
  return new TextDecoder().decode(cbc(nip04Key(privHex, pubHex), unb64(iv)).decrypt(unb64(ct)));
}

/** The parts of a relay connection this file uses; tests pass a fake. */
export interface NwcTransport {
  publish(e: TransportEvent): Promise<unknown>;
  subscribe(f: TransportFilter, on: (e: TransportEvent) => void): { close(): void };
  close(): void;
}

export type PayOutcome =
  | { kind: 'paid'; preimage: string; fee_sats: number | null }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'unknown'; message: string };

/** Wallet errors that mean nothing was sent (NIP-47 error codes). */
const DEFINITE_NO: Record<string, string> = {
  INSUFFICIENT_BALANCE: 'The purse wallet does not have enough in it.',
  QUOTA_EXCEEDED: "The wallet's own budget for this connection is used up. That is the backstop working.",
  RESTRICTED: 'This connection is not allowed to pay.',
  UNAUTHORIZED: 'The wallet does not recognise this connection any more.',
  NOT_IMPLEMENTED: 'This wallet cannot pay invoices over this connection.',
  RATE_LIMITED: 'The wallet asked to slow down. Try again in a minute.',
  PAYMENT_FAILED: 'The payment could not find a route and nothing was sent.',
};

function waitFor<T>(ms: number, start: (done: (v: T) => void) => () => void, fallback: T): Promise<T> {
  return new Promise(resolve => {
    let stop: () => void = () => {};
    const t = setTimeout(() => { stop(); resolve(fallback); }, ms);
    stop = start(v => { clearTimeout(t); stop(); resolve(v); });
  });
}

/** What the wallet's info event says: does it speak nip44, may we pay? */
async function walletInfo(t: NwcTransport, conn: NwcConnection, ms: number): Promise<{ nip44: boolean; canPay: boolean }> {
  const ev = await waitFor<TransportEvent | null>(
    ms,
    done => {
      const sub = t.subscribe({ kinds: [NWC_INFO_KIND], authors: [conn.walletPubkey], limit: 1 }, e => {
        void verifyEvent(e).then(ok => ok && e.pubkey === conn.walletPubkey && done(e));
      });
      return () => sub.close();
    },
    null,
  );
  if (!ev) return { nip44: false, canPay: true };
  const enc = ev.tags.find(x => x[0] === 'encryption')?.[1]?.split(/\s+/) ?? [];
  const methods = ev.content.split(/\s+/);
  return { nip44: enc.includes('nip44_v2'), canPay: methods.includes('pay_invoice') };
}

export async function payInvoice(opts: {
  conn: NwcConnection;
  invoice: string;
  paymentHash: string;
  transport?: NwcTransport;
  infoTimeoutMs?: number;
  replyTimeoutMs?: number;
}): Promise<PayOutcome> {
  const { conn } = opts;
  const t: NwcTransport = opts.transport ?? new NostrTransport({ relays: conn.relays });
  try {
    const info = await walletInfo(t, conn, opts.infoTimeoutMs ?? 4000);
    if (!info.canPay) return { kind: 'failed', code: 'RESTRICTED', message: DEFINITE_NO.RESTRICTED };
    const body = JSON.stringify({ method: 'pay_invoice', params: { invoice: opts.invoice } });
    const content = info.nip44 ? encryptTo(body, conn.walletPubkey, conn.secret) : nip04Encrypt(body, conn.walletPubkey, conn.secret);
    const tags: string[][] = [['p', conn.walletPubkey], ['expiration', String(Math.floor(Date.now() / 1000) + 60)]];
    if (info.nip44) tags.push(['encryption', 'nip44_v2']);
    const req = await buildEvent({
      pubkey: conn.clientPubkey,
      sign: d => toHex(schnorr.sign(d, fromHex(conn.secret))),
      kind: NWC_REQUEST_KIND,
      content,
      tags,
    });
    const reply = await waitFor<TransportEvent | null>(
      opts.replyTimeoutMs ?? 60000,
      done => {
        const sub = t.subscribe({ kinds: [NWC_RESPONSE_KIND], authors: [conn.walletPubkey], '#e': [req.id] }, e => {
          void verifyEvent(e).then(ok => ok && e.pubkey === conn.walletPubkey && done(e));
        });
        void t.publish(req);
        return () => sub.close();
      },
      null,
    );
    if (!reply) return { kind: 'unknown', message: 'The wallet did not answer in time. Check the wallet before trying again; paying the same invoice again cannot pay twice.' };
    let parsed: { result_type?: string; error?: { code?: string; message?: string } | null; result?: { preimage?: string; fees_paid?: number } | null };
    try {
      const text = reply.content.includes('?iv=')
        ? nip04Decrypt(reply.content, conn.walletPubkey, conn.secret)
        : decryptFrom(reply.content, conn.walletPubkey, conn.secret);
      parsed = JSON.parse(text);
    } catch {
      return { kind: 'unknown', message: 'The wallet answered, but the answer could not be read.' };
    }
    if (parsed.error) {
      const code = String(parsed.error.code ?? 'OTHER');
      if (DEFINITE_NO[code]) return { kind: 'failed', code, message: DEFINITE_NO[code] };
      return { kind: 'unknown', message: `The wallet answered "${String(parsed.error.message ?? code).slice(0, 120)}". It is not clear whether anything was sent.` };
    }
    const preimage = String(parsed.result?.preimage ?? '').toLowerCase();
    if (!receiptMatches(preimage, opts.paymentHash)) {
      return { kind: 'unknown', message: 'The wallet says it paid, but its receipt does not match this invoice. Check the wallet.' };
    }
    const fees = Number(parsed.result?.fees_paid);
    return { kind: 'paid', preimage, fee_sats: Number.isFinite(fees) && fees >= 0 ? Math.ceil(fees / 1000) : null };
  } finally {
    if (!opts.transport) t.close();
  }
}
