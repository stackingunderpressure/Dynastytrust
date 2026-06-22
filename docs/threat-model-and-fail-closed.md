# Threat model: added security on a consensus floor, failing closed

Status: captured design note (operator refinement, 2026-06-22). Not a
feature spec -- a threat model + design invariants that constrain every
build above it. Extends the risk register (`docs/build-map-and-cut-lists.md`
section 6) and the layered-legs frame
(`docs/layered-vault-legs-and-frost.md`).

---

## 0. The operator's frame (captured, in his words)

Bitcoin consensus is the floor: it checks that a spend is valid and in
order. On top of that, the app should add a LOCAL layer of security so an
attacker would need so many pieces of the model -- descriptor, keys, the
app's checks, the agreed sequence -- that acting out of order trips a
flag; the flag notifies the members, who can react before the attacker
finishes; and the whole thing **fails closed** ("default to broke, not
default to you-could-steal-everything"). Explicitly humble: not total, not
the only, not perfect security -- ADDED security, such that **you cannot
use our platform to cheat someone**. The honest path is: everybody
proposed it, everybody voted, everybody is in agreement, everybody tested
it through their Tapit wallet -- THEN it is go-for-green. Anything else,
the wallet will not assemble for you.

This note states precisely where that buys real protection, where it
cannot, and how to design around the gaps.

---

## 1. The one hard truth that scopes everything

**The app cannot consensus-enforce anything that is not in the Bitcoin
script.** An attacker who holds enough keys plus the descriptor can sign
with any wallet (Sparrow, Coldcard, a 50-line script) and broadcast
straight to the network. Bitcoin will accept it if the script is
satisfied -- our proposals, votes, attestations, sequence checks, and
tripwires are not consulted by any node. Therefore:

- The **script is the only tamper-PROOF tier.** Quorums, timelocks, leaf
  structure, consent/protector legs -- these are enforced by every node on
  earth and cannot be bypassed.
- Everything the app adds is **tamper-EVIDENT, fail-closed coordination** --
  it makes the honest path safe and makes deviation noisy, but it cannot
  physically stop a key-holder who goes around it.

Two design consequences fall straight out, and they govern the rest of the
build:

1. **Push every rule you can DOWN INTO THE SCRIPT.** That is the only layer
   that actually stops an attacker. The app layer is for the rules Bitcoin
   cannot express (who proposed, who voted, liveness, sequence).
2. **The platform must never be a SHORTCUT around the script.** This is the
   invariant that makes the operator's "you cannot cheat with our
   platform" literally true: the app must never hold or assemble spending
   authority that needs FEWER pieces than the script already requires. At
   most it is the honest convenience path. Deviating from it can never gain
   you anything the raw keys did not already give you -- it only costs you
   the convenience and trips an alarm. **If we ever ship a feature that
   lets someone assemble a valid spend with fewer pieces than the script
   demands, THAT feature is the vulnerability.** Every cut gets checked
   against this.

---

## 2. Defense in depth -- three tiers, honestly labeled

- **Tier 1 -- Consensus / script (the only hard stop).** Maximize here.
  Rich legs: timelock asymmetry, beneficiary-consent gate, protector path,
  decaying quorums. Anything you can express as `thresh` / `after` /
  separate leaves is enforced by the network, not by us.
- **Tier 2 -- Tamper-evident coordination (the ceremony).** propose ->
  vote -> attest -> test-through-wallet -> go-for-green. The app refuses to
  build or co-sign outside this sequence, and every step is a signed,
  timestamped attestation (OpenTimestamps to a block) so deviation is
  provable after the fact. This is where "the platform will not do it for
  you out of sequence" lives. It protects the honest user from mistakes and
  forces an attacker entirely OFF-platform (where they lose our
  conveniences and trip Tier 3).
- **Tier 3 -- The tripwire + response.** Out-of-order, duress, or
  unexpected-broadcast detection raises an alarm to all members (over the
  Tapit attestation inbox) and arms the honest response.

The labels matter: only Tier 1 prevents. Tiers 2 and 3 make the honest
path safe and the dishonest path noisy and slow. Selling Tier 2/3 as
prevention would be the dishonest tap the whole project exists to refuse.

---

## 3. The tripwire only has teeth if it triggers a Tier-1 response

"They could sweep the funds before the attacker could" is true ONLY if the
honest defenders hold a **consensus-advantaged** path -- not merely a faster
human reflex. A notification alone cannot stop a thief who already has the
keys; an alert does not outrun a broadcast. The teeth are always a script
asymmetry:

- **Timelock asymmetry.** The attacker's reachable path is timelocked; the
  honest parties hold an immediate path. The alarm fires, the honest
  parties sweep on their open leg, and the attacker's locked leg cannot
  race them. This is the deepest reason the everyday/fast leg should belong
  to the people you trust most and the dangerous late legs should be
  timelocked out.
- **Duress -> withhold -> fall to timelock.** (The Q4 model, generalized.)
  When the fast leg is a FROST aggregate, a duress signal makes the honest
  share-holders WITHHOLD, the fast leg becomes unsatisfiable, and the coins
  fall to a timelocked recovery only the honest parties can reach. The
  attacker who captured the ceremony cannot complete it, and cannot reach
  the recovery leg in time.

Design rule: **never build a tripwire whose only consequence is a
notification.** Wire every alarm to a consensus-enforced asymmetry, or be
honest that it is forensics (proof after the fact), not defense.

---

## 4. Fail closed, everywhere the app has discretion

Default to broke. Where the app has any say, the safe default is to NOT
act:

- The signer refuses to assemble or sign a spend that was not proposed,
  voted, attested, and in-sequence. Missing a piece -> build nothing.
- Ambiguous duress vs. membership-loss -> read as duress, do not act (Q4).
- A descriptor/address mismatch, a stale tree, an unverified
  attestation -> stop, do not sign.

With timelocks in the tree, "do nothing" structurally favors the honest
party, who can wait; the attacker is the one who needs the system to act.
Fail-closed plus timelocks turns inaction into the honest party's ally.
This is the opposite of a fail-open custodian, where as long as some
quorum signs, value moves -- our default must be "nobody moves it" until
the full ceremony is green.

---

## 5. The honest hard problems (put on the table, with how to step around)

- **P1 -- Key-holder bypass (the big one).** Anyone with enough keys +
  the descriptor signs off-platform; nothing we build stops them.
  *Step around:* minimize who can act alone; put churning/weak roles behind
  FROST aggregates (no single extractable key to steal); design quorums so
  no easily-colludable subset is sufficient; add consent/protector legs;
  and make the easy path the safe path so honest users never have a reason
  to go around the app and learn the off-platform route.
- **P2 -- Tripwire latency vs. block time.** A human sweep cannot reliably
  beat a broadcast (a block is ~10 min; first-seen + fee races are not
  guarantees). *Step around:* rely on the Tier-1 timelock asymmetry of
  section 3, never on winning a mempool race. RBF/CPFP fee-bumping can help
  the honest tx win IF both are valid and it is purely a fee contest, but
  treat that as a long shot, not a control.
- **P3 -- Coordination state is not consensus.** Votes/proposals in
  Supabase or Nostr can simply be ignored by a key-holder. *Step around:*
  anchor every ceremony step in signed attestations timestamped to a block
  (OpenTimestamps), and make the honest co-sign REQUIRE them -- so the only
  way to skip the ceremony is to skip our app entirely, which itself trips
  the "off-platform spend" alarm (section 6). The DB is convenience; the
  attestation chain is the evidence.
- **P4 -- Insider with a full quorum.** If the attacker IS the quorum (two
  colluding trustees in a 2-of-3), no app layer stops them -- only other
  script legs do. *Step around:* quorum design + a beneficiary-consent gate
  and/or protector leg so the easily-colludable subset is never by itself
  sufficient.
- **P5 -- Compromised device lies about what you are signing.** If malware
  owns the phone/browser, our screen can show "pay Alice" while signing
  "pay Mallory." *Step around:* the hardware wallet is the trusted display
  -- tap-to-confirm the real destination + amount on the HW device, not on
  our screen. Our banner shows meaning; the HW device is the source of
  truth for what actually gets signed. (This is a core reason parents are
  on hardware.)
- **P6 -- The descriptor is semi-public.** It lives in backups and is
  needed to watch/recover. *Step around:* do not treat descriptor secrecy
  as a control -- it is useless without keys. Keys are the only secret;
  spend the paranoia there.

None of these are solved by adding app cleverness; they are managed by
pushing policy into Tier 1 and being honest about Tier 2/3's role.

---

## 6. The watchtower -- out-of-order detection that actually helps

Watch every vault address on-chain (mempool + new blocks). Any spend that
did NOT originate from a green ceremony is an UNSANCTIONED spend -> instant
alarm to all members over the Tapit inbox. Honestly bounded:

- It **cannot undo** a confirmed spend. It is detection, not prevention.
- Its real value: (a) it is the proof-of-compromise that arms the honest
  sweep of any REMAINING funds and the rotation of the whole vault to fresh
  keys; (b) paired with scheduled **re-anchoring** (the deadman refresh --
  you periodically move funds to a fresh output with a further-out
  timelock), an unexpected move BETWEEN scheduled re-anchors is a loud red
  flag, and the next re-anchor is the moment to sweep to safety if anything
  looks off; (c) for staged attacks (someone funds a child, probes a path)
  it gives the head start the operator described.

The watchtower is the cleanest concrete embodiment of "it would throw a
flag and notify the architecture" -- as long as it is sold as the tripwire
+ forensics + sweep-the-rest tool, not as a wall.

---

## 7. Where this tells us to invest in the build

1. **Maximize Tier 1.** Rich legs in the composer (consent gate, protector,
   timelock asymmetry on the everyday-vs-dangerous split). Every rule that
   CAN be script SHOULD be script.
2. **Make Tier 2 fail-closed by construction.** The in-app signer (next
   build step) must refuse to sign unless the spend came through the full
   attested ceremony -- propose, vote, test-through-wallet, go-for-green.
   Design it fail-closed from line one, not as a bolt-on.
3. **Build the Tier-3 watchtower + duress->fall-to-timelock wiring** so
   tripwires have teeth (section 3), not just notifications.
4. **Always:** hardware wallet as the trusted display (P5); attestations
   are never spend signatures; keys never leave the browser unencrypted.
5. **Check every cut against the section 1 invariant:** does this feature
   ever let someone assemble a valid spend with fewer pieces than the
   script requires? If yes, it is the vulnerability -- redesign it.

---

## 8. The honest one-liner

We cannot make a vault that an insider holding the keys can never drain --
no software can, and any tool that claims to is lying. What we CAN do, and
must: make the easy path the safe path, make every deviation either
consensus-impossible (Tier 1) or loudly evidenced and timelock-disadvantaged
(Tiers 2-3), and fail closed so the system defaults to "nobody moves it"
rather than "anyone can." Added security on a consensus floor -- not
perfect, but real, and never a shortcut an attacker would rather use than
attacking Bitcoin itself.
