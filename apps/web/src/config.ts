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
// Keys = the key manager for every vault, not scoped to any one of them
// (operator, 2026-08-08: "it's gonna be the key manager for all of your
// vaults so it shouldn't be anywhere near the vault... its own place");
// Start = the guided intent-first front door; Learn = Sage. Policy
// builder + Reminders are still routed but stay out of top-level nav --
// reached through the journey, so a newcomer doesn't land on a raw
// builder screen.
export const NAV_LINKS: readonly NavLink[] = [
  { id: 'home', label: 'Home', icon: '🏦', path: '/vaults' },
  { id: 'keys', label: 'Keys', icon: '🔑', path: '/keys' },
  { id: 'start', label: 'Start a vault', icon: '✨', path: '/start' },
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
