# Build note: cleaning up the vault, send and signing screens

Status: NOTE ONLY. No code until the operator says go.

## The ask (operator, 2026-11-25, in his words)

"Lets cosmeticly cleanse all those screens I just used. They are bulky and
track weird. You might have to scroll to a section after you click a button.
And it's just cluttered from all the building. Audit it and make sure the
right attention is called to correct places at the right time. No buried or
camouflage buttons amongst other stuff."

The screens he used today: the vault page (Overview), Send, and the page
for one spend request (signing, then broadcast).

## How this was audited

- A walk at phone width (375 px), with the server faked so the real page
  renders for a vault like his: a signet fresh-address vault with two paths,
  "Everyday signers" (1 of 2) and "Path 2" (if untouched, 100 blocks), one
  coin on receive address 2, one request waiting. Screenshots are in
  `scratchpad/walk/shots/`, not the repo. The faked server is not his data.
- Reading the code for each screen: `pages/VaultDetail.tsx`,
  `pages/ProposalDetail.tsx`, `components/CurrentAddressCopy.tsx`,
  `components/NewReceiveAddress.tsx`, `components/HaltVaultBar.tsx`.

## What is wrong now (found, not guessed)

### Vault page

1. **Tapping Send does nothing you can see.** The button switches tabs but
   the page doesn't scroll. The form opens below the balance box, both
   address sections and two rows of tabs, all off screen. The same goes for
   every tab: the content changes out of sight.
2. **Two competing ways to get an address.** "Copy receive address" (a
   ghost button, added today) sits above an older block: a paragraph, a
   "Who is it for?" box, and a big gold "Show receive address" button. The
   gold one is the loudest thing after Send, so the eye lands on the older
   path.
3. **The copy confirmation vanishes.** After a copy, the line saying which
   address number was copied disappears after 2.5 seconds
   (`CurrentAddressCopy`: the text shows only while `copied` is true).
4. **The halt warning comes before the vault.** "Not sure a request is really
   safe to sign? Halt signing..." and its red button sit above the balance on
   every visit, even when nothing is wrong. The circle phrase setup and sent
   secrets panels also sit up there when present.
5. **Delete sits in the header** right beside Rotate, in red, on every visit.
   It's the most permanent action on the page and the easiest to hit.
6. **Eight tabs wrap onto two rows.** History's badge (a request waiting)
   lands in the middle of the clutter.
7. **The bottom half is building leftovers.** There are three empty "add one"
   cards (trust document, scheduled stipends, distribution wallets), each
   with a paragraph. Then a descriptor block with ten buttons in a grid and
   the raw descriptor printed out, and the fingerprint at the very bottom.
8. **What is right and stays:** the "1 proposal awaiting signatures — Open
   it" card is clear. So are the per-coin wait times and the coins list.

### Send tab

9. **The form is at the bottom.** The balance box and both address sections
   (from the page above) come first, then the whole coins list again with
   its explanation paragraph. "Review & sign" is about two and a half
   screens down.
10. Picking coins is optional (the app picks), yet the coin list comes
    before the destination and amount.

### Request page (spend request)

11. **The sign buttons come after the discussion.** The order is: summary,
    progress, member list, discussion and comments, then "Sign with your
    key", then Tapit, then hardware wallet. The thing you came to do is
    below a conversation.
12. **Broadcast appears at the bottom.** When the last signature lands, the
    green "Broadcast transaction" button shows up under the hardware wallet
    card, off screen. Right under it is "Cancel proposal" in the same style.
13. A red "Do not sign this request" warning (transaction doesn't match)
    shows below the sign buttons, not above them.

## What would be built

One rule for all three screens: **the next thing you need to do is at the
top, in gold; everything else is quieter; the dangerous things are at the
bottom and ask before they act; and after any button, the page scrolls to
whatever it opened.**

### Vault page, top to bottom

1. **A red banner only when something is wrong**: a duress hold, a missing
   key. The halt control moves (decision 1).
2. **Balance box:** balance, then two equal buttons, **Send** and **Receive**.
   Receive opens one panel with the address to give out now, its QR and a
   Copy button, and a line that stays: "Address number 3, never used
   before. Ends in …kcj3n. It stays the one to give out until money arrives
   on it." Under it, two quiet links: "I need a different address (for a
   label)", which holds the old "Who is it for?" box, and "Addresses given
   out". Explorer becomes a small link under the balance.
3. **"Needs you" card** (today's "awaiting signatures" card), right under
   the balance, whenever there is something to do.
4. **Tabs** (decision 3).
5. Overview content: coins; then what can spend now and the spending paths.
6. **The three "add one" cards** (trust document, stipends, distribution
   wallets) keep their cards but their empty paragraphs shrink to one line
   each. (Built this way instead of one merged card: each card loads its
   own data, and merging them meant rewriting three working components.)
7. **"Backups and exports"**, closed by default: the ten descriptor buttons
   and the raw descriptor go inside. The fingerprint stays visible on the
   closed card, because it's the thing to write down.
8. **Delete** (decision 2).

Scrolling: Send, Receive and every tab bring the opened part to the top of
the screen.

### Send tab

- A one-line balance at the top in place of the big balance box, plus the
  form: path, send to, amount, fee, memo, Review & sign.
- "Choose which coins (optional)" is a closed section under the amount,
  holding the coins list and its paragraph. Opening it from a coin's "Spend
  only this" still works as today.
- After Review & sign, the review screen scrolls into view.

### Request page, top to bottom

1. Summary (amount, to, path) and progress, as today.
2. **"Do not sign" warning**, if any, above everything you could tap.
3. **Your move**, in one card: sign with your key, Tapit, or hardware
   wallet. When enough signatures are in, this card becomes the green
   Broadcast button and scrolls into view.
4. Members, then the discussion.
5. Cancel proposal, at the bottom, set apart, and asks "Cancel this request?
   The signatures collected so far are discarded" before acting.

## Decisions that are the operator's

1. **Halt signing.** (a) A small "Halt signing" link in a safety line under
   the balance box. It turns into the red banner when a hold is on.
   (Recommended.) (b) Keep it above the balance as now.
2. **Delete vault.** (a) Move it to the very bottom of Overview, under a
   "Remove this vault" heading, with today's confirmation. (Recommended.)
   (b) Keep it in the header.
3. **Tabs.** (a) Four tabs: Overview, Send, History, Members, plus a "More"
   tab holding Requests, Messages, Trust and Activity. A badge on More
   whenever something inside needs you. (Recommended.) (b) Keep all eight,
   in one row that scrolls sideways. (c) Leave them as they are.
4. **Slicing.** (a) Vault page first, shipped and walked, then Send, then the
   request page. (Recommended.) (b) All three in one release.

## Blast radius (read from the code, 2026-11-25)

- `pages/VaultDetail.tsx` (9,098 lines; already far over the 800-line limit
  — this work moves blocks and doesn't add new ones, and splitting the file
  is not part of it): the header, balance box, tab bar, `OverviewTab` order,
  `SendTab` form order, and the descriptor section.
- `components/CurrentAddressCopy.tsx` (becomes the Receive panel),
  `components/NewReceiveAddress.tsx` (moves behind its link),
  `components/HaltVaultBar.tsx` (where it sits; what it does is unchanged).
- `pages/ProposalDetail.tsx`: render order, the Broadcast scroll, and a
  confirm on Cancel.
- Tests: `test-readability.mjs` and `test-no-viewport-traps.mjs` read the
  files and must stay green. No test scripts click these screens
  (`offline-harness.sh` drives the signer, not the page). The walk harness
  in the scratchpad is used to re-shoot every screen before and after.
- Not touched: the server, money logic, signing, the addresses chosen,
  warning wording (moved, not reworded), Tapit.
- People: what each screen says first changes. No promise to anyone
  changes.

## Deliberately left out

- The Members, Messages, Trust, Requests and Activity tabs' insides,
  the vault wizard, Keys, the vault list, and Tapit.
- Splitting `VaultDetail.tsx` into files (worth doing; its own slice).
- The one-address (older) vault's balance box beyond the shared changes.
- BIP-138 backup file (its own Build Note, after this).

## Operator's decisions (2026-11-25)

1. Halt signing: a small link under the balance; the red banner at the top
   only while a hold is on.
2. Delete vault: at the bottom of Overview.
3. Tabs: four plus More.
4. All three screens in one release.

## Built (2026-11-25)

- Vault page: Send and Receive under the balance. Receive opens one panel:
  the address to give out now, its number and state, a Copy button, the
  QR, and the line about checking the last 8 characters. Everything stays
  on screen. Behind one link: a note for who it's for, and "I need a
  different one". "Addresses given out" stays a link. Explorer is a small
  link, and Halt is a small red button beside it. The "needs you" card
  comes before the coins. Backups and exports are closed, with the
  fingerprint showing. Delete is at the bottom. Every other tab shows a
  one-line balance. The tabs are Overview, Send, History, Members and More.
  Every tab change scrolls to the tab.
- Send: the form comes first. "Choose which coins" is closed, and its
  note about joining deposits lives inside it. Review scrolls into view.
  Once enough have signed, Broadcast sits right under the signatures and
  the other ways to sign hide. Cancel is set apart, in red, and asks before
  discarding signatures.
- Found by the walk and fixed: on a fresh-address vault the Send review's
  count stayed at "0 / 1 required" after a browser key signed. That screen
  missed the multipath mapping the request page and the server got on
  2026-11-25. The request page now says SIGNET, not TESTNET.
- Request page: the "do not sign" warning comes first, then Broadcast
  (scrolled into view when it appears) or the ways to sign, then members
  and discussion, then Cancel, set apart.
- `CurrentAddressCopy.tsx`, added this morning, is gone. Its job moved into
  the Receive panel (`NewReceiveAddress.tsx`), so there is one way to get
  an address instead of two.

Walked at 375 px against a faked server (walk/after2.cjs in the scratchpad).
Every tapped result landed fully on screen. No page errors.
