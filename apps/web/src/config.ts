// Centralized app configuration. Anything user-visible or environment-dependent
// should go here so it can be changed in one place.

export const APP_NAME = 'DYNASTYTRUST';
export const APP_TAGLINE = 'Bitcoin multisig inheritance vaults';

export interface NavLink {
  id: string;
  label: string;
  icon: string;
  path: string;
}

// Nav reframed around the user's journey, not the technical assembly line
// (see docs/ux-coherence-redesign.md). Home = my vaults + what needs me;
// Start = the guided intent-first front door; Learn = Sage; Keys = the key
// manager, promoted to top-level nav on 2026-08-18 at the operator's
// explicit request (previously reached only through the vault-build
// journey). Policy builder and Reminders stay off top-level nav.
export const NAV_LINKS: readonly NavLink[] = [
  { id: 'home', label: 'Home', icon: '🏦', path: '/vaults' },
  { id: 'start', label: 'Start a vault', icon: '✨', path: '/start' },
  { id: 'keys', label: 'Keys', icon: '🔑', path: '/keys' },
  { id: 'learn', label: 'Learn', icon: '💬', path: '/assistant' },
] as const;

export type Network = 'bitcoin' | 'testnet' | 'signet';

// mempool.space endpoints for each network. Used for broadcasting, tx lookup,
// and UI links. Swap these if we ever move off mempool.space.
export const EXPLORER = {
  bitcoin: {
    api: 'https://mempool.space/api',
    web: 'https://mempool.space',
  },
  testnet: {
    api: 'https://mempool.space/testnet/api',
    web: 'https://mempool.space/testnet',
  },
  signet: {
    api: 'https://mempool.space/signet/api',
    web: 'https://mempool.space/signet',
  },
} as const;

export function explorerTxUrl(network: Network, txid: string): string {
  return `${EXPLORER[network].web}/tx/${txid}`;
}

export function broadcastTxUrl(network: Network): string {
  return `${EXPLORER[network].api}/tx`;
}

export const FEATURES = {
  // Reserved for future experiments. Keep additive so pages can short-circuit.
} as const;
