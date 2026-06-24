import { schnorr } from '@noble/curves/secp256k1';
import type { Attestation } from '../types.js';
import { bytesToHex, canonicalJson, hexToBytes, isHex, taggedHash, utf8ToBytes } from '../internal.js';
import { envelopeId } from './envelope.js';
import { verifyEnvelope } from './keys.js';
import type { AttestationStore } from './sync.js';
import { MemoryStore, toRecord } from './sync.js';

/** A signed request asking peers to return their copies of a subject's attestations. */
export interface RecoveryRequest {
  v: 1;
  /** The identity whose history is being rebuilt. */
  subject: string;
  /** x-only public key of the requester. */
  requester: string;
  issuedAt: string;
  /** The requester's signature over the request digest. */
  signature: string;
}

/** A peer's signed response carrying every attestation it holds for the subject. */
export interface RecoveryResponse {
  v: 1;
  request: RecoveryRequest;
  /** x-only public key of the responding peer. */
  responder: string;
  issuedAt: string;
  attestations: Attestation[];
  /** The responder's signature over the response digest. */
  signature: string;
}

type RequestBase = Omit<RecoveryRequest, 'signature'>;
type ResponseBase = Omit<RecoveryResponse, 'signature'>;

function requestBase(request: RecoveryRequest): RequestBase {
  return {
    v: request.v,
    subject: request.subject,
    requester: request.requester,
    issuedAt: request.issuedAt,
  };
}

function responseBase(response: RecoveryResponse): ResponseBase {
  return {
    v: response.v,
    request: response.request,
    responder: response.responder,
    issuedAt: response.issuedAt,
    attestations: response.attestations,
  };
}

function requestDigest(base: RequestBase): Uint8Array {
  return taggedHash('tapit/recovery-request', utf8ToBytes(canonicalJson(base)));
}

function responseDigest(base: ResponseBase): Uint8Array {
  return taggedHash('tapit/recovery-response', utf8ToBytes(canonicalJson(base)));
}

/** Build a signed recovery request. */
export function buildRecoveryRequest(input: {
  subject: string;
  requesterPrivateKey: string;
  issuedAt?: string;
}): RecoveryRequest {
  if (!isHex(input.requesterPrivateKey, 32)) {
    throw new Error('requesterPrivateKey must be 32-byte hex');
  }
  const priv = hexToBytes(input.requesterPrivateKey);
  const base: RequestBase = {
    v: 1,
    subject: input.subject,
    requester: bytesToHex(schnorr.getPublicKey(priv)),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
  };
  return { ...base, signature: bytesToHex(schnorr.sign(requestDigest(base), priv)) };
}

/** Verify a recovery request's signature. Never throws. */
export function verifyRecoveryRequest(request: RecoveryRequest): boolean {
  if (!isHex(request.signature, 64) || !isHex(request.requester, 32)) return false;
  try {
    return schnorr.verify(
      hexToBytes(request.signature),
      requestDigest(requestBase(request)),
      hexToBytes(request.requester),
    );
  } catch {
    return false;
  }
}

/**
 * Build a signed recovery response. Pulls every attestation involving the
 * subject — both where the subject IS the subject and where it is a
 * signer — out of the responder's store (the dual-storage index).
 */
export async function buildRecoveryResponse(input: {
  request: RecoveryRequest;
  store: AttestationStore;
  responderPrivateKey: string;
  issuedAt?: string;
}): Promise<RecoveryResponse> {
  if (!verifyRecoveryRequest(input.request)) {
    throw new Error('recovery request signature is invalid');
  }
  if (!isHex(input.responderPrivateKey, 32)) {
    throw new Error('responderPrivateKey must be 32-byte hex');
  }
  const priv = hexToBytes(input.responderPrivateKey);
  const subject = input.request.subject;
  const found = [
    ...(await input.store.bySubject(subject)),
    ...(await input.store.bySigner(subject)),
  ];
  const seen = new Set<string>();
  const attestations: Attestation[] = [];
  for (const record of found) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    attestations.push(record.envelope);
  }
  const base: ResponseBase = {
    v: 1,
    request: input.request,
    responder: bytesToHex(schnorr.getPublicKey(priv)),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    attestations,
  };
  return { ...base, signature: bytesToHex(schnorr.sign(responseDigest(base), priv)) };
}

export interface RecoveryVerifyResult {
  /** True when the response envelope and its embedded request are authentic. */
  valid: boolean;
  /** Only the self-verifying attestations from the response. */
  attestations: Attestation[];
  errors: string[];
}

/**
 * Verify a recovery response. The response envelope is checked, and every
 * attestation inside is checked independently — each one is
 * self-verifying, so a tampered or unsigned attestation is dropped and
 * the rebuilt wallet stays trustless regardless of peer honesty.
 */
export function verifyRecoveryResponse(response: RecoveryResponse): RecoveryVerifyResult {
  const errors: string[] = [];
  if (!isHex(response.signature, 64) || !isHex(response.responder, 32)) {
    return { valid: false, attestations: [], errors: ['malformed responder signature'] };
  }
  let valid = true;
  let responderOk = false;
  try {
    responderOk = schnorr.verify(
      hexToBytes(response.signature),
      responseDigest(responseBase(response)),
      hexToBytes(response.responder),
    );
  } catch {
    responderOk = false;
  }
  if (!responderOk) {
    errors.push('responder signature is invalid');
    valid = false;
  }
  if (!verifyRecoveryRequest(response.request)) {
    errors.push('embedded recovery request signature is invalid');
    valid = false;
  }
  const attestations: Attestation[] = [];
  for (const attestation of response.attestations) {
    if (verifyEnvelope(attestation).valid) {
      attestations.push(attestation);
    } else {
      errors.push(`dropped tampered or unsigned attestation ${envelopeId(attestation)}`);
    }
  }
  return { valid, attestations, errors };
}

export interface RebuildResult {
  store: MemoryStore;
  attestations: Attestation[];
  errors: string[];
}

/**
 * Rebuild a wallet from peer recovery responses. Every returned
 * attestation is self-verifying, so the rebuilt wallet is trustless — no
 * need to trust any individual peer didn't tamper. Honest limit: this
 * recovers SHARED attestations (the reputation-bearing ones); purely
 * private, never-shared attestations rely on the encrypted backup.
 */
export async function rebuildFromResponses(
  responses: RecoveryResponse[],
): Promise<RebuildResult> {
  const store = new MemoryStore();
  const errors: string[] = [];
  const merged = new Map<string, Attestation>();
  for (const response of responses) {
    const result = verifyRecoveryResponse(response);
    errors.push(...result.errors);
    for (const attestation of result.attestations) {
      merged.set(envelopeId(attestation), attestation);
    }
  }
  for (const attestation of merged.values()) {
    await store.put(toRecord(attestation));
  }
  return { store, attestations: [...merged.values()], errors };
}

/**
 * v1.1 SLOT — recovery orchestration: peer discovery, requiring N
 * corroborating peers before trusting a record, quarantine of
 * single-source attestations. v1 ships the signed request/response
 * message shapes plus verify + rebuild.
 */
export function orchestrateRecovery(): never {
  throw new Error('orchestrateRecovery is a v1.1 slot — not implemented in v1');
}
