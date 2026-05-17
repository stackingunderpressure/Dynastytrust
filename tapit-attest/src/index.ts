/**
 * tapit-attest -- a standalone signed-attestation primitive.
 *
 * One envelope shape carries six kinds of attestation across three
 * trust tiers. Schnorr / secp256k1 signatures, a Merkle field tree,
 * OpenTimestamps anchoring, a hash-linked key-succession chain,
 * recomputable weighting, a revocation state machine, client-side
 * encryption, a storage-agnostic sync interface, and peer-rebuild
 * recovery foundations.
 *
 * Zero Bitcoin-script dependency. See README.md for the v1 surface
 * and the named v1.1+ slots.
 */

// Field tree
export {
  leaf,
  branch,
  treeFromObject,
  fieldTreeRoot,
  countNodes,
  findLeafValue,
  disclosureProof,
  type FieldScalar,
  type FieldLeaf,
  type FieldBranch,
  type FieldNode,
} from './core/field-tree.js';

// Kinds + tiers
export {
  ATTESTATION_KINDS,
  isAttestationKind,
  type AttestationKind,
} from './core/kinds.js';
export {
  DEFAULT_TIERS,
  tierConfig,
  isTierName,
  evaluateTier,
  type TierName,
  type TierConfig,
  type TierEvaluation,
} from './core/tiers.js';

// Envelope
export {
  ENVELOPE_VERSION,
  createDraft,
  attestationDigest,
  canonicalEnvelope,
  envelopeId,
  assertWellFormed,
  type Anchor,
  type AttestationSignature,
  type AttestationEnvelope,
  type DraftOptions,
} from './core/envelope.js';

// Per-kind builders
export {
  identityAttestation,
  relationshipAttestation,
  credentialAttestation,
  predictionAttestation,
  agreementAttestation,
  metaAttestation,
  type BuildOptions,
  type MetaOp,
} from './core/builders.js';

// Keys + signing
export {
  generateKeypair,
  publicKeyFromPrivate,
  isPublicKey,
  isSignature,
  type Keypair,
} from './core/keys.js';
export {
  signEnvelope,
  verifySignature,
  verifyEnvelope,
  type SignOptions,
  type VerifyResult,
} from './core/sign.js';

// Anchoring
export {
  anchorAttestation,
  refreshAnchor,
  verifyAnchor,
  MockOtsProvider,
  type OtsProvider,
  type AnchorConfirmation,
  type AnchorVerification,
} from './core/anchor.js';
export { OpenTimestampsProvider } from './anchor/opentimestamps-provider.js';

// Key succession
export {
  createSuccessionLink,
  verifySuccessionChain,
  type SuccessionLink,
  type BuildLinkOptions,
  type ChainVerification,
} from './core/succession.js';

// Weighting
export {
  computeWeight,
  advancedWeighting,
  type WeightTable,
  type WeightResult,
  type WeightingPolicy,
} from './core/weighting.js';

// Revocation
export {
  createRevocation,
  revocationTarget,
  RevocationLedger,
  repudiate,
  type RevocationStatus,
  type CreateRevocationOptions,
} from './core/revocation.js';

// Encryption
export {
  encrypt,
  decrypt,
  decryptToString,
  PBKDF2_ROUNDS,
  type EncryptedBlob,
} from './core/encryption.js';

// Sync
export {
  toRecord,
  loadVerified,
  MemoryStore,
  SyncEngine,
  type StoredAttestation,
  type AttestationStore,
  type SyncReport,
} from './core/sync.js';

// Recovery
export {
  buildRecoveryRequest,
  verifyRecoveryRequest,
  buildRecoveryResponse,
  verifyRecoveryResponse,
  rebuildFromResponses,
  orchestrateRecovery,
  type RecoveryRequest,
  type RecoveryResponse,
  type ResponseVerification,
} from './core/recovery.js';
