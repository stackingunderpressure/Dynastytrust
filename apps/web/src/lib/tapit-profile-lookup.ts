/**
 * tapit-profile-lookup.ts -- resolve a vault signer's real Tapit Wallet
 * display name from their Bitcoin pubkey (2026-08-13, operator: "each
 * tapit wallet should be identified by the name they have on tap it").
 *
 * For a key whose origin is Tapit, keystore.ts's LocalKey docs the exact
 * relationship: the vault-script pubkey stored everywhere in this app
 * (founder_keys/heir_keys/vault_members.pubkey, 66-char compressed hex)
 * is the LIFTED form of the wallet's own BIP340 x-only pubkey -- '02' +
 * that 32-byte value. That x-only value is also the wallet's Nostr
 * identity (tapit-wallet's nostrProfile.ts: "The wallet's BIP340 pubkey
 * IS its Nostr identity"), under which it publishes a standard NIP-01
 * kind-0 profile with a real display_name. So the vault's own pubkey
 * array is already the exact key to query -- no new field, no join
 * through vault_membership_grants, just strip the compression prefix
 * and ask the relays who that is.
 *
 * Deliberately tolerant of a non-Tapit key (hardware wallet, plain
 * software key): querying a pubkey nobody ever published a kind-0
 * event under just returns nothing, and the caller falls back to the
 * locally-typed member label. Forging a NAME under someone else's
 * pubkey would require a valid Schnorr signature for that pubkey --
 * i.e. control of the private key -- so a resolved name is only ever
 * as trustworthy as the real key owner's own self-report, the same
 * trust level as any Nostr profile anywhere.
 */

import { NostrTransport, verifyEvent } from '@dynastytrust/nostr-transport';
import { DEFAULT_RELAYS } from './tapit-nostr-cosign';

const PROFILE_KIND = 0;
// Best-effort collection window -- long enough for the handful of
// fast public relays in DEFAULT_RELAYS to answer, short enough that a
// vault page with no Tapit-connected signers doesn't feel like it hung.
const COLLECT_WINDOW_MS = 2500;

interface ProfileContent {
  name?: string;
  display_name?: string;
}

// Session-lived cache, cleared on reload -- same lifetime as every
// other best-effort Nostr lookup in this app. Profile names are
// reasonably static; re-opening a relay subscription on every
// VaultDetail render would be wasteful.
const cache = new Map<string, string>();

/** Strips the compressed-pubkey prefix ('02'/'03' + 32 bytes) down to
 *  the bare 32-byte x-only hex Nostr uses as a pubkey. Returns null for
 *  anything that isn't a well-formed compressed or already-x-only hex
 *  string, so a malformed vault key never turns into a bogus query. */
function toXOnlyHex(pubkeyHex: string): string | null {
  const hex = pubkeyHex.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hex)) return hex;
  if (/^(02|03)[0-9a-f]{64}$/.test(hex)) return hex.slice(2);
  return null;
}

async function runFetch(xOnlyPubkeys: string[], relays: readonly string[]): Promise<void> {
  const transport = new NostrTransport({ relays });
  const latest = new Map<string, { created_at: number; name: string }>();
  try {
    await new Promise<void>(resolve => {
      const sub = transport.subscribe(
        { kinds: [PROFILE_KIND], authors: xOnlyPubkeys, limit: xOnlyPubkeys.length * 4 },
        event => {
          void (async () => {
            if (event.kind !== PROFILE_KIND) return;
            if (!(await verifyEvent(event))) return;
            let parsed: unknown;
            try {
              parsed = JSON.parse(event.content);
            } catch {
              return;
            }
            if (!parsed || typeof parsed !== 'object') return;
            const content = parsed as ProfileContent;
            const name = (content.display_name || content.name || '').trim();
            if (!name) return;
            // kind-0 is a replaceable event -- keep only the newest
            // one seen per pubkey in case a relay serves stale copies.
            const existing = latest.get(event.pubkey);
            if (!existing || event.created_at > existing.created_at) {
              latest.set(event.pubkey, { created_at: event.created_at, name });
            }
          })();
        },
      );
      setTimeout(() => {
        sub.close();
        resolve();
      }, COLLECT_WINDOW_MS);
    });
  } finally {
    transport.close();
  }
  for (const [pubkey, { name }] of latest) {
    cache.set(pubkey, name);
  }
}

/**
 * Resolves display names for a set of vault-script pubkeys (66-char
 * compressed hex, the shape founder_keys/heir_keys/etc. and
 * vault_members.pubkey all use). Returns a map keyed by the ORIGINAL
 * input string so callers can look results up without re-deriving the
 * x-only form themselves. Missing entries mean no kind-0 profile was
 * found in the collection window -- callers fall back to a local
 * label, never to an error state; this is a courtesy label, never a
 * signing decision.
 */
export async function fetchTapitDisplayNames(
  pubkeys: readonly string[],
  relays: readonly string[] = DEFAULT_RELAYS,
): Promise<Map<string, string>> {
  const byXOnly = new Map<string, string[]>(); // xOnly -> original pubkey strings
  for (const pk of pubkeys) {
    const xOnly = toXOnlyHex(pk);
    if (!xOnly) continue;
    const list = byXOnly.get(xOnly) ?? [];
    list.push(pk);
    byXOnly.set(xOnly, list);
  }

  const uncached = Array.from(byXOnly.keys()).filter(xOnly => !cache.has(xOnly));
  if (uncached.length > 0) {
    await runFetch(uncached, relays);
  }

  const result = new Map<string, string>();
  for (const [xOnly, originals] of byXOnly) {
    const name = cache.get(xOnly);
    if (!name) continue;
    for (const original of originals) result.set(original, name);
  }
  return result;
}
