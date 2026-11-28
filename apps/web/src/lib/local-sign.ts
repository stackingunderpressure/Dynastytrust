/**
 * local-sign.ts -- sign a DT-ATT-v1 attestation with the member's own key
 * on this device. Moved out of TrustTab (2026-11-28) so the family purse's
 * signed yeses use the very same path: find the active local key whose
 * pubkey is the member's registered vault key, unlock it (password through
 * the caller's dialog), derive the /0/0 child and Schnorr-sign. The
 * mnemonic never leaves this function.
 */
import type { Vault } from './api';
import { keyNeedsPassword, listKeys, revealMnemonic } from './keystore';
import { signAttestation, type AttestationType } from './attest';

export function attestNetwork(n: Vault['network']): 'testnet' | 'signet' | 'mainnet' {
  if (n === 'bitcoin') return 'mainnet';
  if (n === 'signet') return 'signet';
  return 'testnet';
}

export async function signWithLocalKey(opts: {
  pubkey: string | null | undefined;
  attestationType: AttestationType;
  targetHash: string;
  network: Vault['network'];
  // Supplied by the calling component so the password is collected through a
  // styled dialog rather than the native window.prompt.
  requestPassword: (label: string) => Promise<string | null>;
}): Promise<{ signature: string; pubkey: string }> {
  if (!opts.pubkey) throw new Error('You have no pubkey on this vault yet');
  const keys = listKeys();
  const match = keys.find(
    k => k.status === 'active' && k.pubkey === opts.pubkey,
  );
  if (!match) {
    throw new Error(
      "No local key matches your vault pubkey. Import the mnemonic on this device.",
    );
  }
  const needsPw = keyNeedsPassword(match);
  const pw = needsPw
    ? (await opts.requestPassword(match.label)) ?? undefined
    : undefined;
  if (needsPw && !pw) throw new Error('Password required');
  const mnemonic = await revealMnemonic(match.keyId, pw);
  const res = signAttestation({
    mnemonic,
    derivationPath: match.derivationPath,
    network: attestNetwork(opts.network),
    attestationType: opts.attestationType,
    targetHash: opts.targetHash,
  });
  return res;
}
