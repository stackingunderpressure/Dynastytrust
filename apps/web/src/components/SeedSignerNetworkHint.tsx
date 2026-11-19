import { colors } from '../theme';

/**
 * Under a hardware-signing QR on a test-coin vault: SeedSigner has no
 * Signet setting -- signet and testnet both sign as Testnet -- and left on
 * its default Mainnet it signs anyway, showing every address as bc1
 * (live hardware walk, 2026-11-19). The SeedSigner fork now warns too; this
 * says it before the signer ever scans.
 */
export function SeedSignerNetworkHint({ network }: { network: string }) {
  if (network === 'bitcoin') return null;
  return (
    <div style={{ fontSize: 15, color: colors.orange, marginTop: 6, textAlign: 'center', lineHeight: 1.5 }}>
      Test coins: on SeedSigner, set Settings &gt; Advanced &gt; Bitcoin network to Testnet first
      (it signs signet as Testnet). On Mainnet it shows every address as bc1.
    </div>
  );
}
