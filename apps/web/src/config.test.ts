import { describe, it, expect } from 'vitest';
import { explorerTxUrl, broadcastTxUrl } from './config';

// Pin the exact per-network endpoints. A wrong explorer/broadcast URL would
// point a user (or a broadcast) at the wrong chain, so these are load-bearing.
const TXID = 'a'.repeat(64);

describe('explorerTxUrl', () => {
  it('builds the mempool.space tx link per network', () => {
    expect(explorerTxUrl('bitcoin', TXID)).toBe(`https://mempool.space/tx/${TXID}`);
    expect(explorerTxUrl('testnet', TXID)).toBe(
      `https://mempool.space/testnet/tx/${TXID}`,
    );
    expect(explorerTxUrl('signet', TXID)).toBe(
      `https://mempool.space/signet/tx/${TXID}`,
    );
  });
});

describe('broadcastTxUrl', () => {
  it('builds the mempool.space broadcast endpoint per network', () => {
    expect(broadcastTxUrl('bitcoin')).toBe('https://mempool.space/api/tx');
    expect(broadcastTxUrl('testnet')).toBe('https://mempool.space/testnet/api/tx');
    expect(broadcastTxUrl('signet')).toBe('https://mempool.space/signet/api/tx');
  });
});
