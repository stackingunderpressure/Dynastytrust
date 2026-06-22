# Watchtower spec -- the on-chain tripwire

Status: build spec (operator-approved 2026-06-22). Implements Tier 3 of
`docs/threat-model-and-fail-closed.md` section 6. Honest by construction:
this is DETECTION + FORENSICS + arm-the-sweep, NOT prevention. It cannot
undo a confirmed spend. Its job is to turn "something moved that should
not have" into a loud, fast alarm with the receipts, so the honest parties
react on a Tier-1 (consensus) path before more is lost.

---

## 1. What it does, in one line

Watch every vault address on-chain. Any spend that did NOT originate from
a green ceremony (a proposal this app built + broadcast) is an
UNSANCTIONED spend -> instant alarm to all members, with the proof, and an
armed "sweep the remainder / rotate the vault" action.

---

## 2. The core comparison (sanctioned vs observed)

The watchtower holds two sets per vault and diffs them:

- **Sanctioned txids** -- transactions THIS app broadcast from a green
  ceremony. Every time the app finalizes + broadcasts, it records the
  resulting txid (and the inputs it spent) against the proposal. This is
  the allow-list.
- **Observed spends** -- transactions seen on-chain (mempool + confirmed)
  that spend a UTXO belonging to the vault address.

`observed \ sanctioned` = unsanctioned spends. Each one is an alarm.

Why this works: by the fail-closed gate
(`evaluateSigningGate`), the app only ever signs/broadcasts a
ceremony-bound transaction, so every legitimate move is in the sanctioned
set. Anything else came from off-platform -- exactly the deviation the
threat model says we cannot prevent but CAN make loud.

---

## 3. Triggers and signals

- **Unsanctioned spend in the mempool** -> highest-urgency alarm
  ("unconfirmed: someone is moving funds you did not approve"). This is the
  head-start window -- minutes, sometimes, before confirmation.
- **Unsanctioned spend confirmed** -> alarm + arm the response (sweep the
  remaining UTXOs on an honest path; rotate the vault to fresh keys).
- **Unexpected move between scheduled re-anchors** -> red flag. The deadman
  refresh (move funds to a fresh output with a further-out timelock) is on
  a schedule; an on-chain move that is not a scheduled re-anchor and not a
  sanctioned spend is suspicious even if it looks like a self-send.
- **Funding of a child/distribution address that was not proposed** -> note
  (staged-attack probe).

Every signal is delivered over the Tapit attestation inbox (the Q4
coordination layer) to all members, plain-language, tap-to-acknowledge.

---

## 4. Honest limits (do not oversell)

- **Detection, not prevention.** A confirmed unsanctioned spend cannot be
  reversed. The watchtower's value is the remainder + the rotation + the
  proof, not undo.
- **Must be always-on.** A watchtower asleep at the moment of the spend
  misses the head start. So the poller is SERVER-SIDE and scheduled, not a
  browser tab that has to be open. (A browser-only watchtower is a
  best-effort bonus, never the guarantee.)
- **Races are not guarantees.** Even with a mempool head start, beating an
  attacker's broadcast on-chain needs a Tier-1 asymmetry (the honest party
  holds an immediate path, the attacker's is timelocked) -- see threat
  model section 3. The watchtower arms that response; it does not win a fee
  race by itself.
- **Reorgs / RBF.** An observed spend can be replaced (RBF) or reorged out.
  Treat a mempool alarm as provisional and a 1-2 conf alarm as firm; do not
  cry wolf on a replaced-by-self tx (match against sanctioned RBF bumps).
- **Privacy.** Watching your own vault address is fine; the watchtower must
  not leak the address set to third parties beyond the block source already
  used (mempool.space). A self-hosted Esplora is the sovereign upgrade.

---

## 5. Architecture (grounded in what exists)

- **Block/mempool source:** mempool.space (already used across the app for
  balance, fees, broadcast, UTXOs). Address spend feed via polling
  `GET /address/:addr/txs` (and `/utxo`) per network; later, the websocket
  for lower latency. Esplora self-host is the no-trust upgrade.
- **Sanctioned-set store:** the proposals table already records spend
  proposals; extend it (or a `vault_broadcasts` table) with the broadcast
  `txid` + the spent outpoints, written at the moment the app broadcasts.
- **The poller:** a scheduled backend job (Netlify scheduled function or a
  small always-on worker) that, per active vault, fetches recent address
  txs, diffs against the sanctioned set, and emits alarms. Cadence: tight
  (e.g. 1-2 min) for funded vaults; back off for empty ones.
- **Alarm transport:** the Tapit encrypted Nostr inbox / attestation
  surface (the coordination layer from threat model section 6) -> every
  member's wallet, plain-language, tap-to-acknowledge.
- **Armed response:** the alarm links to a one-tap "propose emergency
  sweep" that opens a ceremony on the honest path (e.g. parents-together,
  or the protector leg) to move the REMAINING funds to a fresh vault -- which
  itself goes through the fail-closed gate. Detection hands off to the
  normal green-ceremony machinery; it never auto-moves funds (no control).

---

## 6. Build order (its own batch, after persistence)

Depends on vault persistence + the broadcast-record write (so there IS a
sanctioned set). Then:

1. **Record the sanctioned set:** on every broadcast, persist
   `{ proposalId, txid, spentOutpoints }`. (Small; pairs with persistence.)
2. **The diff core (pure, testable):** `findUnsanctioned(observedTxs,
   sanctionedTxids) -> alarms[]`, default-suspicious (an unknown txid
   spending the vault is an alarm). Unit-tested like the signing gate.
3. **The poller:** scheduled function calling mempool.space, feeding the
   diff core, deduping alarms (do not re-alarm the same txid).
4. **Alarm delivery:** over the Tapit inbox, with the armed-sweep handoff.
5. **Re-anchor scheduler tie-in:** flag moves that fall outside the
   re-anchor cadence.

Rungs 1-2 are verifiable here (pure logic + a DB write). Rungs 3-5 need the
deploy + the Tapit bridge, so they land once that wiring exists -- same
honest ceiling as the rest of the climb.

---

## 7. One-line honest framing

The watchtower is the smoke detector, not the fire-proof wall: it cannot
stop the fire, but it screams the instant one starts, hands you the proof,
and points you at the extinguisher (the honest sweep on a Tier-1 path)
while there is still something to save.
