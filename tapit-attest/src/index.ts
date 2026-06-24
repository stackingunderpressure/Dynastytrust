/**
 * tapit-attest — a standalone signed-attestation primitive.
 *
 * One envelope shape carries six kinds of attestation across three trust
 * tiers. BIP340 Schnorr over secp256k1, a Merkle field tree, optional
 * OpenTimestamps anchoring. Zero Bitcoin-script dependency.
 */
export * from './types.js';
export * from './core/field-tree.js';
export * from './core/envelope.js';
export * from './core/keys.js';
export * from './core/tiers.js';
export * from './core/builders.js';
export * from './core/anchoring.js';
export * from './core/ots-codec.js';
export * from './core/succession.js';
export * from './core/weighting.js';
export * from './core/revocation.js';
export * from './core/encryption.js';
export * from './core/nip44.js';
export * from './core/sync.js';
export * from './core/recovery.js';
export * from './core/sign-in.js';
export * from './core/shamir.js';
export * from './core/wallet.js';
