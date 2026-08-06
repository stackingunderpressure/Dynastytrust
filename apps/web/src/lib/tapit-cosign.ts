/**
 * tapit-cosign.ts -- browser half of Cut B (the DynastyTrust <-> Tapit
 * signing bridge), stage B2: docs/integration-phase1-signin-and-bridge.md,
 * docs/build-map-and-cut-lists.md DT-4.
 *
 * Unlike wallet-signin.ts (sign-in, a full-page redirect that's fine to
 * lose SPA state over), signing a vault spend happens from deep inside
 * VaultDetail's in-memory `signing` session -- there is no "resume signing
 * this proposal" entry point today, so a full-page navigation away and
 * back would strand that state. Cut B2 avoids inventing that machinery
 * under time pressure on money-touching code: it opens the Tapit sign
 * flow in a NEW TAB (window.open, never window.location) so the original
 * tab's signing session is never disturbed, and the callback tab hands
 * the result back via a same-origin localStorage write + the browser's
 * own `storage` event -- the standard cross-tab primitive, no server
 * round trip needed for the handoff itself.
 *
 * Transport contract = the tapit-wallet sign-request protocol (DT is the
 * consumer, same as wallet-signin.ts, different intent):
 *   request:  <WALLET>/sign?req=<b64url(JSON{intent:'psbt-cosign',origin,callback,psbt_hex,vault_context})>
 *   response: <callback>?psbt_grant=<base64(JSON{v,psbt_hex})>
 *   Deliberately a DIFFERENT query param name (psbt_grant, not grant) from
 *   wallet-signin.ts's sign-in flow -- RequireAuth.tsx's boot() checks for
 *   a bare `grant` param on EVERY authed page load to redeem a sign-in
 *   callback; reusing that name here would make RequireAuth try to treat
 *   a signed PSBT as a sign-in proof on every page in this tab.
 *
 * Keys never touched here. The PSBT and the returned partial signature
 * are the only things that cross this seam -- same as the existing
 * hardware-wallet export/import path this reuses on the receiving end
 * (VaultDetail's externalImport + mergePsbts, unchanged).
 */

import { WALLET_SIGN_URL, b64urlEncode, b64Decode } from './wallet-signin';

/** Cross-tab handoff key. The callback tab writes; the original tab
 *  listens via the `storage` event and clears it once consumed. */
export const TAPIT_COSIGN_RESULT_KEY = 'dynastytrust:tapit-cosign-result';

export interface TapitCosignResult {
  psbt_hex: string;
  at: number;
}

export interface VaultContext {
  vault_descriptor: string;
  vault_name?: string;
}

/**
 * Open the Tapit sign flow in a new tab for this PSBT. Fire-and-forget --
 * the original tab keeps its signing session and picks up the result via
 * the storage-event listener wired in VaultDetail.
 */
export function startTapitCosign(psbtHex: string, vaultContext: VaultContext): void {
  const callback = `${window.location.origin}/tapit-cosign-callback`;
  const req = b64urlEncode({
    v: 1,
    intent: 'psbt-cosign',
    origin: 'DynastyTrust',
    callback,
    psbt_hex: psbtHex,
    vault_context: vaultContext,
  });
  window.open(`${WALLET_SIGN_URL}?req=${req}`, '_blank', 'noopener,noreferrer');
}

/** If the current URL is a psbt-cosign wallet redirect, parse it.
 *  Returns null when absent or malformed -- never throws. */
export function readTapitCosignGrant(): { psbt_hex?: string } | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('psbt_grant');
  if (!raw) return null;
  try {
    return b64Decode<{ psbt_hex?: string }>(raw);
  } catch {
    return null;
  }
}

export function clearTapitCosignCallbackUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('psbt_grant');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}
