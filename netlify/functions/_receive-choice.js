// Which receive address to show (docs/receive-address-reuse-until-paid-
// build-note.md; operator, 2026-11-24: "If I click on an address and don't
// use it there is no way to go back and use it it just skips to next one.
// Nunchick only counts after it's used on chain", then "Mix: Nunchuk + new
// button"). Pure: the caller supplies the issued addresses and which of
// them have ever been paid.

/** Wallets restoring a vault (Sparrow, Nunchuk, Bitcoin Core) stop looking
 *  after about this many addresses in a row with no history. */
export const GAP_LIMIT = 20;

/**
 * The newest issued receive address never paid, or null. Address 0 is the
 * vault's own address, shown on its overview, so it is never the one
 * offered here.
 * @param {{idx:number,address:string,label:string|null}[]} issued
 * @param {Set<string>} used
 */
export function currentUnpaid(issued, used) {
  return [...issued].filter((a) => a.idx > 0 && !used.has(a.address)).sort((a, b) => b.idx - a.idx)[0] ?? null;
}

/**
 * How many addresses in a row, after the last one ever paid, a restoring
 * wallet would see as empty -- counting reserved numbers too (a reserved but
 * unrecorded number still leaves a hole). `nextIndex` is the next number the
 * branch would reserve.
 */
export function unpaidRun(nextIndex, issued, used) {
  const paid = issued.filter((a) => used.has(a.address)).map((a) => a.idx);
  const lastPaid = paid.length ? Math.max(...paid) : -1;
  return Math.max(0, nextIndex - 1 - lastPaid);
}

/** The lowest issued change address never paid (a spend built but never
 *  broadcast leaves one), or null. */
export function reusableChange(issuedChange, used) {
  return [...issuedChange].filter((a) => !used.has(a.address)).sort((a, b) => a.idx - b.idx)[0] ?? null;
}
