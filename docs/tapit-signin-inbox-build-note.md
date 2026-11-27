# Build note: Tapit sign-in through Tapit's inbox, not a link hand-off

Status: approved by the operator's chip "Inbox delivery (Recommended)",
2026-11-27.

## The ask (operator, 2026-11-27)

"Also signing in with tapit to dynasty is broken. Not making the full round
trip properly." On the same phone, after tapping Open Tapit: "Only thing I
saw in tapit was for a spend. Not sure if it was old but never saw sign in
one." Both apps are home-screen apps.

## Cause (from the code; consistent with what the operator saw)

The sign-in page (`Auth.tsx`) offers one route only: an "Open Tapit" link to
`tapit-wallet.netlify.app/sign?req=...`. On an iPhone, a link never opens
inside a home-screen app. It opens a Safari tab, and that tab has its own
storage, apart from the installed Tapit. So:

- the request goes to a Tapit in Safari that holds no wallet, not to the one
  the operator uses;
- the installed Tapit only showed what was in its own inbox (an old spend);
- even if it were approved, the trip back would land in Safari, not in the
  DynastyTrust home-screen app. Its "did this browser start it" check
  (threat model G) would then refuse it.

"Create an account with Tapit" uses the same link, so it has the same
problem.

## What would be built

The inbox route already exists and works between apps: it's what "Link an
existing wallet" uses (`TapitConnectModal`). The request goes over Nostr to
the Tapit public key, appears in Tapit's home banner and Inbox, and the
signed answer comes back over Nostr to the waiting DynastyTrust screen. No
link and no app switch.

- "Sign in with Tapit" and "Create an account with Tapit" open that same
  window (mode `signin` / `signup`), instead of the link.
- The window leads with "Send to my Tapit":
  - If this device remembers a Tapit key, it is sent there straight away,
    showing the sign-in number and "Open Tapit and approve it there".
  - Otherwise, a box asks for the key, with "Tapit > Settings > Public key"
    as the hint.
  - The QR (another device) and "Open Tapit in Safari" stay underneath, for
    other setups.
- After any successful Tapit sign-in, link or sign-up, this device
  remembers that Tapit's public key. It is public, not a secret, and stays
  on this device only. There's a "Use a different Tapit" option.
- The answer is still accepted only if it is signed by the key the request
  was sent to (Kimi K3 #146, unchanged). The sign-in number check and the
  "started in this browser" check are unchanged.

## Blast radius

- `apps/web/src/pages/Auth.tsx`: the Tapit sign-in and sign-up buttons.
- `apps/web/src/components/TapitConnectModal.tsx`: its layout, the
  remembered key, and the auto-send. It's also used by "Link an existing
  wallet" on the Keys page, which gets the same layout.
- `apps/web/src/lib/wallet-signin.ts`: remember and read the Tapit key.
- Server, Tapit, and the sign-in checks: unchanged. The `/keys?grant=`
  redirect return keeps working for anyone who uses the Safari link.

## Deliberately left out

- Any Tapit change. Its inbox already handles sign-in requests.
- Push notifications to wake Tapit. The person opens Tapit to see the
  request.
