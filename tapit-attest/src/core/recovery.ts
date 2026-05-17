/**
 * Peer-rebuild recovery foundations.
 *
 * Because every attestation is dual-stored (sync.ts) and self-
 * verifying (its signatures stand on their own), a wallet that loses
 * its local store can rebuild it from peers. The peer does not have
 * to be trusted: every record it returns is re-verified on arrival.
 *
 * v1 ships the DATA FOUNDATIONS -- the signed request/response
 * message shapes and the verify + rebuild functions. The full
 * recovery UX (peer discovery, requiring N corroborating peers,
 * quarantine of suspect records) is a named v1.1 slot
 * (`orchestrateRecovery` below).
 */

import { schnorr } from '@noble/curves/secp256k1';
import { taggedHash, TAGS } from '../internal/hash.js';
import { canonicalJson } from '../internal/canonical.js';
import { fromHex, randomBytes, toHex, utf8 } from '../internal/hex.js';
import { isPublicKey, isSignature, publicKeyFromPrivate } from './keys.js';
import { loadVerified, MemoryStore, type StoredAttestation } from './sync.js';

export interface RecoveryRequest {
  readonly type: 'recovery_request';
  readonly v: 1;
  /** x-only public key of the wallet asking to be rebuilt. */
  readonly requester: string;
  /** Identity / subject whose attestations are being recovered. */
  readonly subject: string;
  /** Random hex nonce; the response must echo it. */
  readonly nonce: string;
  readonly issuedAt: string;
  /** Schnorr signature by `requester` over the message digest. */
  readonly sig: string;
}

export interface RecoveryResponse {
  readonly type: 'recovery_response';
  readonly v: 1;
  /** x-only public key of the responding peer. */
  readonly responder: string;
  readonly subject: string;
  /** Echoes the request nonce, binding response to request. */
  readonly nonce: string;
  readonly records: readonly StoredAttestation[];
  readonly issuedAt: string;
  /** Schnorr signature by `responder` over the message digest. */
  readonly sig: string;
}

function requestDigest(r: Omit<RecoveryRequest, 'sig'>): Uint8Array {
  return taggedHash(TAGS.recovery, utf8(canonicalJson(r as unknown)));
}

function responseDigest(r: Omit<RecoveryResponse, 'sig'>): Uint8Array {
  return taggedHash(TAGS.recovery, utf8(canonicalJson(r as unknown)));
}

/** Build a signed recovery request. */
export function buildRecoveryRequest(opts: {
  subject: string;
  privateKey: string | Uint8Array;
  nonce?: string;
  issuedAt?: string;
}): RecoveryRequest {
  const unsigned: Omit<RecoveryRequest, 'sig'> = {
    type: 'recovery_request',
    v: 1,
    requester: publicKeyFromPrivate(opts.privateKey),
    subject: opts.subject,
    nonce: opts.nonce ?? toHex(randomBytes(16)),
    issuedAt: opts.issuedAt ?? new Date().toISOString(),
  };
  const priv = typeof opts.privateKey === 'string' ? fromHex(opts.privateKey) : opts.privateKey;
  return { ...unsigned, sig: toHex(schnorr.sign(requestDigest(unsigned), priv)) };
}

/** Verify a recovery request's signature. */
export function verifyRecoveryRequest(req: RecoveryRequest): boolean {
  try {
    if (!isPublicKey(req.requester) || !isSignature(req.sig)) return false;
    const { sig, ...unsigned } = req;
    return schnorr.verify(fromHex(sig), requestDigest(unsigned), fromHex(req.requester));
  } catch {
    return false;
  }
}

/** Build a signed recovery response that answers `request`. */
export function buildRecoveryResponse(opts: {
  request: RecoveryRequest;
  records: readonly StoredAttestation[];
  privateKey: string | Uint8Array;
  issuedAt?: string;
}): RecoveryResponse {
  const unsigned: Omit<RecoveryResponse, 'sig'> = {
    type: 'recovery_response',
    v: 1,
    responder: publicKeyFromPrivate(opts.privateKey),
    subject: opts.request.subject,
    nonce: opts.request.nonce,
    records: opts.records,
    issuedAt: opts.issuedAt ?? new Date().toISOString(),
  };
  const priv = typeof opts.privateKey === 'string' ? fromHex(opts.privateKey) : opts.privateKey;
  return { ...unsigned, sig: toHex(schnorr.sign(responseDigest(unsigned), priv)) };
}

export interface ResponseVerification {
  /** Response signature valid AND nonce matches the request. */
  readonly valid: boolean;
  /** Records that individually re-verified (well-formed + signed). */
  readonly verifiedRecords: readonly StoredAttestation[];
  /** Ids of records that failed re-verification. */
  readonly rejected: readonly string[];
  readonly reason?: string;
}

/**
 * Verify a recovery response against the request that triggered it.
 * The responder signature and nonce echo are checked first; then
 * EVERY returned record is independently re-verified, so a hostile
 * peer cannot smuggle in a forged attestation.
 */
export async function verifyRecoveryResponse(
  request: RecoveryRequest,
  response: RecoveryResponse,
): Promise<ResponseVerification> {
  if (response.nonce !== request.nonce) {
    return { valid: false, verifiedRecords: [], rejected: [], reason: 'nonce mismatch' };
  }
  if (response.subject !== request.subject) {
    return { valid: false, verifiedRecords: [], rejected: [], reason: 'subject mismatch' };
  }
  let sigOk = false;
  try {
    if (isPublicKey(response.responder) && isSignature(response.sig)) {
      const { sig, ...unsigned } = response;
      sigOk = schnorr.verify(
        fromHex(sig),
        responseDigest(unsigned),
        fromHex(response.responder),
      );
    }
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return { valid: false, verifiedRecords: [], rejected: [], reason: 'bad responder signature' };
  }

  const verifiedRecords: StoredAttestation[] = [];
  const rejected: string[] = [];
  for (const record of response.records) {
    // Re-verify by round-tripping through a throwaway store.
    const scratch = new MemoryStore();
    await scratch.put(record);
    const ok = await loadVerified(scratch, record.id);
    if (ok && ok.envelope.subject === request.subject) {
      verifiedRecords.push(ok);
    } else {
      rejected.push(record.id);
    }
  }
  return { valid: true, verifiedRecords, rejected };
}

/**
 * Rebuild a subject's attestation set from one or more verified
 * recovery responses, de-duplicated by id, into a fresh store.
 */
export async function rebuildFromResponses(
  request: RecoveryRequest,
  responses: readonly RecoveryResponse[],
): Promise<{ store: MemoryStore; recovered: number; rejected: readonly string[] }> {
  const store = new MemoryStore();
  const rejected: string[] = [];
  let recovered = 0;
  for (const response of responses) {
    const result = await verifyRecoveryResponse(request, response);
    rejected.push(...result.rejected);
    if (!result.valid) continue;
    for (const record of result.verifiedRecords) {
      if (!(await store.get(record.id))) {
        await store.put(record);
        recovered++;
      }
    }
  }
  return { store, recovered, rejected };
}

/**
 * v1.1+ SLOT -- full recovery orchestration.
 *
 * Will add peer discovery, a quorum of corroborating peers before a
 * record is accepted, and quarantine of records only one peer holds.
 * v1 ships the message shapes + verification above.
 */
export function orchestrateRecovery(_request: RecoveryRequest): never {
  throw new Error('orchestrateRecovery: v1.1 slot, not implemented in v1');
}
