// Does a hardware wallet's exported key belong to this vault's network?
// Read from the key's own prefix, before anything re-encodes it: a
// mainnet key re-labelled as a test key would look valid and then fail
// to sign. Pure; tested by scripts/test-hardware-key-import.mjs.

export type VaultNetwork = 'testnet' | 'signet' | 'bitcoin';

const REAL_PREFIX = /^[xyzYZ]pub/;
const TEST_PREFIX = /^[tuvUV]pub/;

/** What is wrong with this key for this vault's network, or null. */
export function networkProblem(xpub: string, network: VaultNetwork): string | null {
  const real = network === 'bitcoin';
  if (real && !REAL_PREFIX.test(xpub)) {
    return `This vault holds real bitcoin, so the key should start with xpub (or ypub/zpub). This one starts with "${xpub.slice(0, 4)}". On the wallet, switch to mainnet and export the key again.`;
  }
  if (!real && !TEST_PREFIX.test(xpub)) {
    return `This vault holds test coins, so the key should start with tpub (or upub/vpub). This one starts with "${xpub.slice(0, 4)}". On the wallet, switch to testnet and export the key again.`;
  }
  return null;
}
