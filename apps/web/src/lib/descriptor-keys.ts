/**
 * descriptor-keys.ts -- single source of truth for turning selected
 * keys into the values the Fly.io compiler + hardware wallets need.
 *
 * Two distinct representations of a key are in play:
 *   - pubkey hex (66 chars, the /0/0 receive-chain child) is what the
 *     Rust compiler embeds in each leaf script.
 *   - the key-origin expression `[fp/path]xpub/0/0` is what Nunchuk /
 *     Sparrow / Coldcard need to recognise the key as theirs.
 *
 * Deliberately NOT a ranged `/0/*` expression (2026-08-06): this vault
 * is a single fixed address by design, not a rotating HD wallet -- our
 * own compiler only ever knows how to build a spend for the exact
 * /0/0 key baked into the leaf script, so a wildcard descriptor would
 * let Nunchuk/Sparrow offer up a SECOND receive address at index 1+
 * that funds could be stranded at (spendable by the hardware wallet
 * directly, but not through this app's own coordinator). A fixed,
 * non-ranged key expression makes every wallet that imports this
 * descriptor show the exact same one address we do -- no foot-gun,
 * no silent mismatch, full behavioral parity by construction.
 *
 * The compiler only ever sees pubkey hex; the browser post-processes
 * the returned descriptor, swapping each raw pubkey for its key-origin
 * expression. Shared by PolicyBuilder and BlocBuilder so the upgrade
 * logic never drifts between the two compile paths.
 */

export interface SelectedKey {
  pubkey: string;
  keyId: string;
  label: string;
  persona: string;
  xpub: string;
  fingerprint: string;
  masterFingerprint?: string;
  derivationPath: string;
  network: string;
}

export interface KeyOrigin {
  fingerprint: string;
  derivationPath: string;
  xpub: string;
}

/**
 * Post-process the compiler's raw-pubkey descriptor into the Nunchuk /
 * Sparrow / Coldcard key-origin form: `pk([fp/path]xpub/0/0)`. The Rust
 * compiler returns `pk(03abcd...)` because it only sees public keys; the
 * browser has the xpub, fingerprint, and derivation path needed to
 * reconstruct the key origin expression.
 *
 * Fixed at /0/0, not a `/0/*` wildcard range -- see this file's header
 * comment for why a ranged descriptor here would be a foot-gun, not a
 * feature.
 *
 * If a key is missing BOTH masterFingerprint and fingerprint it is left
 * as a raw pubkey; hardware wallets will reject that key specifically,
 * but the rest of the descriptor is still upgraded.
 */
export function upgradeDescriptor(
  descriptor: string,
  origins: Record<string, KeyOrigin>,
): string {
  let result = descriptor;
  for (const [pubkeyHex, origin] of Object.entries(origins)) {
    const cleanPath = origin.derivationPath.replace(/^m\//, '');
    const keyExpr = `[${origin.fingerprint}/${cleanPath}]${origin.xpub}/0/0`;
    result = result.split(pubkeyHex).join(keyExpr);
  }
  return result;
}

export function buildKeyOrigins(keys: SelectedKey[]): Record<string, KeyOrigin> {
  const map: Record<string, KeyOrigin> = {};
  for (const k of keys) {
    const pubkeyHex = toPubkeyHex(k);
    const fp = k.masterFingerprint ?? k.fingerprint;
    if (!fp || !k.xpub || !k.derivationPath) continue;
    map[pubkeyHex] = { fingerprint: fp, derivationPath: k.derivationPath, xpub: k.xpub };
  }
  return map;
}

/**
 * BIP32 origins in the shape the PSBT-build endpoints need (2026-08-06
 * hardware-wallet fix) -- distinct from buildKeyOrigins above, which
 * feeds the DESCRIPTOR's key-origin expression `[fp/path]xpub/0/0`. A
 * PSBT's tap_key_origins field needs the full path to the SPECIFIC key
 * used in the script, not the bare account path -- so this appends the
 * /0/0 receive-chain child suffix the compiler always signs with,
 * matching toPubkeyHex's own "the /0/0 receive-chain child" convention.
 * Keys missing fingerprint/derivationPath are silently skipped: that key
 * simply won't get hardware-wallet recognition, same graceful degradation
 * as an absent entry in buildKeyOrigins.
 */
export function buildPsbtKeyOrigins(
  keys: SelectedKey[],
): { pubkey: string; fingerprint: string; derivation_path: string }[] {
  const out: { pubkey: string; fingerprint: string; derivation_path: string }[] = [];
  for (const k of keys) {
    const fp = k.masterFingerprint ?? k.fingerprint;
    if (!fp || !k.derivationPath) continue;
    out.push({
      pubkey: toPubkeyHex(k),
      fingerprint: fp,
      derivation_path: k.derivationPath.replace(/\/+$/, '') + '/0/0',
    });
  }
  return out;
}

// Compressed pubkey hex is stored on each key at generation time.
export function toPubkeyHex(k: SelectedKey): string {
  if (k.pubkey && k.pubkey.length === 66) return k.pubkey;
  console.error('Key missing pubkey:', k.label, 'pubkey:', k.pubkey, 'length:', k.pubkey?.length);
  throw new Error(
    'Key "' + k.label + '" is missing its pubkey. Please go to the Keys tab, delete this key, and generate a new one.',
  );
}
