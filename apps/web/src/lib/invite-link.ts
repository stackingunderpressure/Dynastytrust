/**
 * invite-link.ts -- the invite link carries what the invited person needs to
 * SEE before they join (the vault's name, the name they were invited as) in
 * its fragment, after the `#`. Browsers never send the fragment to a server,
 * so these names travel only inside the link the owner sends, never through
 * DynastyTrust (docs/zero-knowledge-storage-plan.md, Z1 slice 2): the server
 * stores them sealed with the vault key, which the person only gets after
 * they join.
 *
 * Anyone the link is forwarded to sees these two names too -- the same people
 * who could already ask to join with it.
 */
export interface InviteHint {
  vaultName?: string;
  label?: string;
}

export function inviteLink(token: string, hint: InviteHint = {}): string {
  const base = `${window.location.origin}/invite/${token}`;
  const params = new URLSearchParams();
  if (hint.vaultName) params.set('n', hint.vaultName);
  if (hint.label) params.set('l', hint.label);
  const frag = params.toString();
  return frag ? `${base}#${frag}` : base;
}

const STORE = (token: string) => `dt-invite-hint:${token}`;

/** Read the hint from this page's fragment (keeping it for the session, so a
 *  sign-in round trip that drops the fragment does not lose it). */
export function readInviteHint(token: string, hash: string = window.location.hash): InviteHint {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const fromHash: InviteHint = {
    ...(params.get('n') ? { vaultName: params.get('n')! } : {}),
    ...(params.get('l') ? { label: params.get('l')! } : {}),
  };
  try {
    if (fromHash.vaultName || fromHash.label) {
      sessionStorage.setItem(STORE(token), JSON.stringify(fromHash));
      return fromHash;
    }
    const kept = sessionStorage.getItem(STORE(token));
    return kept ? (JSON.parse(kept) as InviteHint) : {};
  } catch {
    return fromHash;
  }
}
