/**
 * @dynastytrust/nostr-transport
 *
 * The Nostr (NIP-01) relay transport, extracted from Tapit Wallet's
 * src/features/transport/{transport,nostrEvent,nostrTransport}.ts (Cut B
 * stage B3 -- docs/integration-phase1-signin-and-bridge.md). This is the
 * substrate DynastyTrust needs to publish a psbt-cosign sign request
 * directly into a vault co-signer's Tapit inbox instead of relying on a
 * deeplink the co-signer has to be handed and open by hand.
 *
 * Pure protocol code: a minimal NIP-01 WebSocket client behind a
 * transport-agnostic Transport interface, plus event build/verify. No
 * wallet, no keys held, no attestation-specific shapes -- the caller
 * supplies a pubkey and a sign(digest) callback (or, for DynastyTrust's
 * ephemeral per-request identity, a raw private key via
 * @noble/curves/secp256k1's schnorr.sign directly) and gets back a
 * TransportEvent ready to publish.
 *
 * THE PARITY GATE, same discipline as bip341-psbt-signer (B0): this
 * module is vendored byte-identically into every repo that needs it.
 * test/parity.test.mjs asserts a fixed golden vector -- a known event
 * input produces an exact, hardcoded event id and the verifier accepts a
 * known-good signature and rejects a tampered one. Running that same
 * test file in each repo's own CI, against that repo's own copy, proves
 * each copy computes identical bytes without the repos needing to talk
 * to each other at test time.
 *
 * To change this module: edit it in tapit-wallet (the canonical source,
 * since the Nostr transport has run the longest and carries the most
 * production surface there -- envelopes, chat, liveness), run the parity
 * test, then mirror src/, test/, package.json, and tsconfig.json
 * byte-for-byte into every vendoring repo, and run each downstream
 * repo's full gates before pushing. Never hand-edit a downstream copy.
 */

export * from './nostrEvent.js';
export * from './transport.js';
export * from './nostrTransport.js';
