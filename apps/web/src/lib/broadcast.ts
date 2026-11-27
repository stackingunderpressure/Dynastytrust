// Sending a signed transaction, and recording that it was sent. Shared by
// the Send screen and the request page.
//
// Operator's phone screenshot, 2026-11-26: a spend that was really in the
// signet mempool showed "Could not find transaction ... mempool.space 404"
// and a "Retry broadcast" button. The send had worked; recording it asked
// mempool.space too soon. And pressing Retry would have re-sent a
// transaction the network already had -- which mempool.space refuses as an
// error. So: a re-send the network already knows counts as sent, and
// recording is retried and reported as recording, never as a failed send.

import { broadcastTxUrl, type Network } from '../config';

const ALREADY = /already in block ?chain|txn-already-in-mempool|txn-already-known/i;
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Send `rawHex`; returns its txid. `expectedTxid` is the txid the
 *  finalizer computed, used when the network already has it. */
export async function sendRawTx(network: string, rawHex: string, expectedTxid: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(broadcastTxUrl(network as Network), {
    method: 'POST',
    body: rawHex,
    headers: { 'Content-Type': 'text/plain' },
  });
  const text = (await res.text()).trim();
  if (!res.ok) {
    if (ALREADY.test(text)) return expectedTxid;
    throw new Error('Broadcast failed: ' + text.slice(0, 100));
  }
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error('Broadcast failed: ' + text.slice(0, 100));
  if (expectedTxid && text.toLowerCase() !== expectedTxid.toLowerCase()) {
    throw new Error('The network reported a different transaction than the one signed. Nothing is recorded; check the explorer.');
  }
  return text;
}

/** Record a sent transaction (e.g. mark the proposal broadcast), retrying:
 *  the server checks it against mempool.space, which can lag a few seconds. */
export async function recordBroadcast(
  record: () => Promise<unknown>,
  { tries = 3, waitMs = 3000, sleep = sleepMs }: { tries?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      await record();
      return;
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(waitMs);
    }
  }
  throw last instanceof Error ? last : new Error('Could not record the send');
}
