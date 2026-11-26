# Blind adversarial review of the newer code (2026-11-25)

This is in-house re-audit step 3 (`docs/in-house-reaudit-build-note.md`).
The reviewer got the code and `CLAUDE.md` and nothing else: none of our
conclusions. It was read-only. "Confirmed" means it traced the code path to
concrete inputs. It does not mean the attack was run against the deployed
app.

The orchestrating session re-checked findings 1, 2 and 3 against the code
the same day: confirmed.

| # | Severity | Status | Finding |
|---|---|---|---|
| 1 | High | Confirmed, re-checked | A duress hold does not stop signing or broadcasting from the request page. Only the Send tab checks `vaults.duress`. `ProposalDetail.tsx` never does, and none of `signer-sessions`, `psbt-binary`, `psbt-merge`, `proposals` or `psbt-finalize` read it. `vault-duress.js:136` claims every signing path refuses; that claim is false. Tapit signers do refuse. |
| 2 | High | Confirmed, re-checked | The owner alone can lift a circle hold, and can block one from being raised. The duress server trusts `vault_membership_grants` rows marked `accepted`. Those rows are created, and marked accepted, by the owner (`vault-membership-grants.js` POST and PATCH filter on `user_id` = the owner), and the recipient key is never checked against the vault's keys. An owner can make grants for keys they hold and sign the clears themselves. |
| 3 | High | Confirmed, re-checked | Change on a fresh-address vault can be sent to any change index the descriptor derives, e.g. 1,000,000. `checkFreshSpendAddresses` (`fresh-addresses.ts`) has no bound, a member can store their own PSBT as a proposal, and browser and hardware co-signers' checks pass it. The app watches only up to the reserved counter + 2, and restoring wallets (gap limit 20) never find it. Tapit signers are bounded to 200 change scripts. |
| 4 | Medium | Confirmed (pure logic run) | A member pointing at their own lying Electrum server can push the shared receive counter past the 20-address gap limit, and view-only members can reserve addresses. Later "copy address" calls then hand out far-off addresses. |
| 5 | Medium | Plausible | Tapit's duress check fails open when DynastyTrust can't be reached or the vault lookup is ambiguous (two vaults sharing a descriptor make `vaultBy` return null). |
| 6 | Low/medium | Confirmed by trace | `psbt-merge` sets a proposal's status from any submitted PSBT, with no same-transaction check. Only the label is wrong; finalizing fails. |
| 7 | Low | Confirmed by trace | The Send tab overcounts signatures on named-field fresh-address vaults: `countSignatures` sums across inputs. |
| 8 | Low | Plausible | IPv4-mapped IPv6 written in hex gets past the Electrum private-address blocklist. Limited impact: TLS is required, and the network can't be reached from the review sandbox. |
| 9 | Low | Design note | Tapit's change check only catches outputs that claim to be the vault's. In wellness mode the checker doesn't see the destination by design. |

## Checked and holding

The reviewer traced each of these and found them sound:

- Mapping a child-key signature to its vault key: a forged derivation can't
  map, and nothing is counted twice.
- The Rust `RangedVault` constructors and the spend builder.
- The browser's and Tapit's own-address checks.
- Address reservation: service role only, with RLS on.
- Electrum pinning, the genesis check, and connecting to the IP that was
  checked.
- Duress notice signatures: a fixed domain, a ±10-minute window, one use
  per signature, and clears counted only after the latest raise.
- The owner-only `vaults.js` switch and CORS limited to Tapit.

## Fix order

Each fix is shipped one at a time. Each gets a test that fails first, the
gates, and the operator's word (decision 3 in the re-audit note).

## Fixes shipped (each with a test that failed first, gates green, operator's word)

| # | Fix | Commit (release) |
|---|---|---|
| 1 | `_duress-guard.js` on signer-sessions, psbt-binary, psbt-merge, proposals; request page refuses and shows the hold | 33978ef (e2f668a) |
| 2 | `circleKeys(vault)`: the circle comes from the compiled wellness path, not the owner-written member list | 31ba408 (714f51e) |
| 3 | `_change-check.js`: change only to a recorded change address; devices refuse change past 1,000 | 004b644 (d707b49) |
| 4 | Only the owner reserves a new receive address (operator's chip) | 93a5315 (1ae06f8) |
| 5 | Tapit: when the hold can't be checked, ask first ("I called the owner and they are safe") | Tapit bc342fc |

Still open, logged: 6 (psbt-merge same-transaction check), 7 (Send overcount
on named-field fresh-address vaults), 8 (IPv6-mapped Electrum blocklist), 9
(design note).
