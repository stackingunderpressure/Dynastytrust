# Build note: tidy the Key Manager into tabs

Status: NOTE ONLY. No code until the operator says go.

## The ask (operator, 2026-11-27)

"In the key manager let's make it more organized. Tabs for each kind of key
instead of mixed. Tapit keys also a tab. And any other thing to tidy it up
compact without loosing functionality or awareness"

## What the page is today (measured at 375 x 812, one key of each kind)

The page is 3,127 px tall. The first key starts about 2,000 px down. Above it
come:
- the page title;
- five account cards (Tapit sign-in, "Face ID for your keys", "Sign in
  without an email", two-step sign-in);
- the recovery-share link;
- five buttons (New key, Restore from words, Import xpub, Export JSON,
  Import JSON);
- a paragraph;
- search;
- Active/Archived/All;
- a row of persona chips.

The keys are then grouped by persona, with every kind mixed together. At
phone width the rows are broken: the Edit / Backup / Delete buttons sit on
top of the fingerprint and the "NOT BACKED UP" badge, and names wrap to
three lines. A row doesn't say whether a key opens with Face ID or a typed
password. The derivation path is shown on every row.

There are three kinds of key in `lib/keystore.ts`:
- `software`: the words are on this device. It's locked one of three ways:
  - Face ID (`passkeyMnemonic`);
  - a password (`encryptedMnemonic`);
  - no lock, a test key (`testMnemonic`).
- `imported_xpub`: a hardware wallet. Public key only.
- `tapit`: public key only. Tapit holds the private key.

Tapit keys are only ever added from the vault wizard. The page has no add
button for them.

## What would be built

**Tabs, one per kind, each with a count:**

| Tab | What's in it | Its own add buttons |
|---|---|---|
| Phone keys | software keys locked by Face ID or a password | New key, Restore from words |
| Hardware | imported xpubs | Import xpub |
| Tapit | Tapit keys, plus the Tapit sign-in card | (added from the vault wizard; the tab says so) |
| Test | unlocked test keys; shown only if there are any | New key (test) |
| Archived | archived keys of every kind; shown only if there are any | none |

Awareness:
- A tab holding a key that isn't backed up gets an orange dot.
- A short "Needs you" strip at the very top lists only what's actually
  outstanding, one line each, and tapping a line goes to the place to fix
  it:
  - "1 key not backed up";
  - "1 key still opens with a typed password";
  - "Two-step sign-in is off".
- If nothing is outstanding, the strip isn't shown.

**Compact rows:**
- Line 1: the name, plus how the key opens: Face ID, Password, Test (no
  lock), Hardware or Tapit.
- Line 2: the fingerprint, MAINNET or TESTNET, and the persona.
- Badges stay for "Not backed up" and archived.
- The derivation path moves to the key's detail screen, where it already
  shows.
- Tapping the row opens the detail screen, which already has every action:
  Edit, Back up / Phrase, Secure, Change or remove password, Archive,
  Delete.

**Account settings** (Face ID sign-in, the email, two-step sign-in, "Face ID
for your keys") move under one "Account & sign-in" section below the keys.
The "Needs you" strip still points at them.

**Smaller things:**
- Export/Import JSON move to a small row at the bottom, keeping their
  "public keys only, not a backup of your words" line.
- The persona chips show only when a tab holds keys for more than one
  persona.
- Search stays.
- The long paragraph becomes one line: "Keys live only on this device; the
  words you wrote down are the backup."

Nothing about how keys are made, stored, locked, backed up or deleted
changes. This is the list and the page layout only.

## Decisions that are the operator's

1. **Where the account cards go.** Below the keys, in one "Account &
   sign-in" section (Recommended). Or keep them where they are, above the
   keys.
2. **The buttons on each row.** Tap the row for every action, with "Back
   up" left on the row only when a key isn't backed up (Recommended). Or
   keep Edit / Backup / Delete on every row, made to fit.
3. **The tab it opens on.** Phone keys (Recommended). Or the tab with the
   most keys.

## Blast radius

- `apps/web/src/pages/KeyManager.tsx`. This is the list and page layout
  only: the main `KeyManager` function, lines 1008-1489. The modals and
  every keystore call are untouched. The list moves to its own file
  (`pages/key-manager/KeyList.tsx`), so the page shrinks toward the
  800-line limit.
- Words other screens tell people about this page. These must stay true,
  and are checked:
  - `InviteClaimPath.tsx` says "Keys page (Import xpub)", "Keys page
    (Backup)" and "turn on two-step sign-in". Import xpub is in Hardware,
    Backup is on the row and in the detail screen, and two-step is in
    Account & sign-in.
  - `KeyPicker`, `VaultMembershipSetup`, `CirclePhraseSetup` and
    `Dashboard` only link to `/keys`. That keeps working.
- Account components (`WalletLinkCard`, `FaceIdLockAll`,
  `FaceIdSignInSetting`, `AccountPrivacyCard`, `TwoStepCard`): moved, not
  changed. Each already hides itself when there's nothing to do. The
  "Needs you" strip reads the same facts they do.
- Tests: `test-readability.mjs` and `test-no-viewport-traps.mjs` scan the
  pages folder and must still pass on the new file. The screen walk gains a
  Keys page check:
  - every tab opens;
  - no row overlaps at 375 px;
  - the detail screen still offers Back up, Archive and Delete.
- The download build (`DOWNLOAD`) has no account. Its Account & sign-in
  section shows only "Face ID for your keys", as today.
- Server, signing, vaults and Tapit: untouched.

## Deliberately left out

- Splitting the modals out of `KeyManager.tsx`. That's a pure move; it can
  follow on its own.
- Adding a Tapit key from this page. It still comes from the vault wizard.
- Any change to how a key is locked, backed up or deleted.
