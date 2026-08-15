// Bitcoin network name reconciliation between the two naming schemes this
// codebase uses for the SAME three networks. lib/keystore.ts's LocalKey
// (and everything that reads listKeys()) tags a key's network as
// 'testnet' | 'signet' | 'mainnet'. Vault, DistributionWallet, and every
// other server-persisted record instead uses 'testnet' | 'signet' |
// 'bitcoin' for that same third network. A naive `k.network === vault.network`
// comparison silently NEVER matches on mainnet -- it works by coincidence
// on testnet/signet (the strings happen to agree) and only breaks for real
// money. Found 2026-08-15 (operator screenshot: "Can't add key to vault.
// Not recognizing key store" on a mainnet vault's Members tab) after this
// exact fix had already shipped once, locally, as VaultWizard.tsx's private
// keyNetworkMatches -- extracted here so every other eligible-key filter in
// the app (VaultDetail.tsx's Members/Tranche/DistributionWallet flows,
// InviteClaim.tsx) uses the one correct comparison instead of a fourth
// divergent copy.
export function keyNetworkMatches(
  keyNetwork: string,
  vaultNetwork: 'testnet' | 'signet' | 'bitcoin',
): boolean {
  if (keyNetwork === vaultNetwork) return true;
  return keyNetwork === 'mainnet' && vaultNetwork === 'bitcoin';
}
