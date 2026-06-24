import type { Anchor, AnchorStatus, Attestation } from '../types.js';
import { bytesToHex, hexToBytes, taggedHash } from '../internal.js';
import { attestationDigest } from './envelope.js';
import {
  assembleProof,
  bitcoinHeight,
  commitmentHex,
  mergeUpgrade,
  parseOtsProof,
  parseTimestampBytes,
  pendingAttestations,
  serializeOtsProof,
} from './ots-codec.js';

export interface StampResult {
  /** Opaque proof blob, hex. */
  proof: string;
  status: AnchorStatus;
  confirmedAt?: string;
  btcHeight?: number;
}

export interface AnchorVerification {
  valid: boolean;
  status: AnchorStatus;
  btcHeight?: number;
  reason?: string;
}

/**
 * A timestamping provider. `anchorAttestation` / `refreshAnchor` /
 * `verifyAnchor` are written against this interface, so the in-memory
 * mock and the real OpenTimestamps provider are interchangeable.
 */
export interface OtsProvider {
  readonly name: string;
  stamp(digest: Uint8Array): Promise<StampResult>;
  upgrade(digest: Uint8Array, proof: string): Promise<StampResult>;
  verify(digest: Uint8Array, proof: string): Promise<AnchorVerification>;
}

/**
 * Offline, deterministic anchor provider for tests and local dev. The
 * proof is a tagged hash of the digest, so `verify` recomputes it with
 * no network. `upgrade` models the OpenTimestamps pending→confirmed
 * lifecycle against a synthetic Bitcoin block height.
 */
export class MockOtsProvider implements OtsProvider {
  readonly name = 'mock';
  private readonly confirmImmediately: boolean;
  private readonly height: number;

  constructor(options: { confirmImmediately?: boolean; btcHeight?: number } = {}) {
    this.confirmImmediately = options.confirmImmediately ?? false;
    this.height = options.btcHeight ?? 840_000;
  }

  private proofFor(digest: Uint8Array): string {
    return bytesToHex(taggedHash('tapit/mock-ots', digest));
  }

  async stamp(digest: Uint8Array): Promise<StampResult> {
    const proof = this.proofFor(digest);
    if (this.confirmImmediately) {
      return {
        proof,
        status: 'confirmed',
        confirmedAt: new Date().toISOString(),
        btcHeight: this.height,
      };
    }
    return { proof, status: 'pending' };
  }

  async upgrade(digest: Uint8Array, proof: string): Promise<StampResult> {
    if (proof !== this.proofFor(digest)) throw new Error('proof does not match digest');
    return {
      proof,
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
      btcHeight: this.height,
    };
  }

  async verify(digest: Uint8Array, proof: string): Promise<AnchorVerification> {
    const ok = proof === this.proofFor(digest);
    return {
      valid: ok,
      status: ok ? 'confirmed' : 'pending',
      btcHeight: ok ? this.height : undefined,
      reason: ok ? undefined : 'proof does not match digest',
    };
  }
}

/** Minimal HTTP shape — injectable so the unit suite can run offline. */
export interface OtsTransport {
  (
    url: string,
    init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: Uint8Array },
  ): Promise<{ ok: boolean; status: number; bytes(): Promise<Uint8Array> }>;
}

const DEFAULT_CALENDAR = 'https://a.pool.opentimestamps.org';

function fetchTransport(): OtsTransport {
  return async (url, init) => {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return {
      ok: res.ok,
      status: res.status,
      bytes: async () => new Uint8Array(await res.arrayBuffer()),
    };
  };
}

/**
 * Real, Bitcoin-backed anchor provider — dependency-free.
 *
 * Built on the in-house `ots-codec`, with no npm `opentimestamps`
 * package. `stamp` submits the digest to a calendar's `/digest`
 * endpoint and wraps the response in a `.ots` proof. `upgrade` reads the
 * pending proof, finds each calendar commitment, and GETs
 * `<calendar>/timestamp/<commitment>` — the correct upgrade pathway; a
 * re-POST to `/digest` only ever returns a fresh pending stamp and never
 * confirms. The HTTP transport is injectable, so the upgrade and verify
 * paths are exercised offline against a fake calendar in the unit suite.
 *
 * Scope boundary: `verify` confirms the proof commits to the given
 * digest and reports a Bitcoin attestation's block height. It does not
 * independently re-validate that commitment against the Bitcoin chain —
 * see `ots-codec`.
 */
export class OpenTimestampsProvider implements OtsProvider {
  readonly name = 'opentimestamps';
  private readonly calendar: string;
  private readonly transport: OtsTransport;

  constructor(options: { calendarUrl?: string; transport?: OtsTransport } = {}) {
    this.calendar = (options.calendarUrl ?? DEFAULT_CALENDAR).replace(/\/+$/, '');
    this.transport = options.transport ?? fetchTransport();
  }

  async stamp(digest: Uint8Array): Promise<StampResult> {
    const res = await this.transport(`${this.calendar}/digest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        Accept: 'application/vnd.opentimestamps.v1',
      },
      body: digest,
    });
    if (!res.ok) {
      throw new Error(`ots: calendar ${this.calendar} returned ${res.status}`);
    }
    const calendarTimestamp = await res.bytes();
    if (calendarTimestamp.length === 0) {
      throw new Error(`ots: calendar ${this.calendar} returned an empty timestamp`);
    }
    return {
      proof: bytesToHex(assembleProof(digest, calendarTimestamp)),
      status: 'pending',
    };
  }

  async upgrade(_digest: Uint8Array, proof: string): Promise<StampResult> {
    const parsed = parseOtsProof(hexToBytes(proof));
    for (const pending of pendingAttestations(parsed)) {
      const base = pending.uri.replace(/\/+$/, '');
      const url = `${base}/timestamp/${commitmentHex(pending.commitment)}`;
      let res;
      try {
        res = await this.transport(url, {
          method: 'GET',
          headers: { Accept: 'application/vnd.opentimestamps.v1' },
        });
      } catch {
        continue; // network hiccup — leave this calendar pending
      }
      // 404 = the calendar has not yet aggregated this commitment into a
      // Bitcoin-confirmed root; any other non-2xx is a transient failure.
      if (!res.ok) continue;
      const body = await res.bytes();
      if (body.length === 0) continue;
      mergeUpgrade(pending.node, parseTimestampBytes(body, pending.commitment));
    }
    const height = bitcoinHeight(parsed);
    const upgradedProof = bytesToHex(serializeOtsProof(parsed));
    if (height !== undefined) {
      return {
        proof: upgradedProof,
        status: 'confirmed',
        confirmedAt: new Date().toISOString(),
        btcHeight: height,
      };
    }
    return { proof: upgradedProof, status: 'pending' };
  }

  async verify(digest: Uint8Array, proof: string): Promise<AnchorVerification> {
    let parsed;
    try {
      parsed = parseOtsProof(hexToBytes(proof));
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unreadable proof';
      return { valid: false, status: 'pending', reason };
    }
    if (bytesToHex(parsed.fileDigest) !== bytesToHex(digest)) {
      return {
        valid: false,
        status: 'pending',
        reason: 'proof does not commit to this digest',
      };
    }
    const height = bitcoinHeight(parsed);
    return height !== undefined
      ? { valid: true, status: 'confirmed', btcHeight: height }
      : { valid: true, status: 'pending' };
  }
}

/** Stamp an attestation's digest and attach the resulting anchor. */
export async function anchorAttestation(
  a: Attestation,
  provider: OtsProvider,
): Promise<Attestation> {
  const digest = attestationDigest(a);
  const result = await provider.stamp(digest);
  const anchor: Anchor = {
    provider: provider.name,
    digest: bytesToHex(digest),
    proof: result.proof,
    status: result.status,
    stampedAt: new Date().toISOString(),
  };
  if (result.confirmedAt) anchor.confirmedAt = result.confirmedAt;
  if (result.btcHeight !== undefined) anchor.btcHeight = result.btcHeight;
  return { ...a, anchor };
}

/** Upgrade a pending anchor — checks whether the timestamp has confirmed. */
export async function refreshAnchor(
  a: Attestation,
  provider: OtsProvider,
): Promise<Attestation> {
  if (!a.anchor) throw new Error('attestation has no anchor to refresh');
  if (a.anchor.status === 'confirmed') return a;
  const digest = attestationDigest(a);
  const result = await provider.upgrade(digest, a.anchor.proof);
  const anchor: Anchor = { ...a.anchor, proof: result.proof, status: result.status };
  if (result.confirmedAt) anchor.confirmedAt = result.confirmedAt;
  if (result.btcHeight !== undefined) anchor.btcHeight = result.btcHeight;
  return { ...a, anchor };
}

/** Verify an attestation's anchor against its recomputed digest. */
export async function verifyAnchor(
  a: Attestation,
  provider: OtsProvider,
): Promise<AnchorVerification> {
  if (!a.anchor) return { valid: false, status: 'pending', reason: 'attestation has no anchor' };
  const digest = attestationDigest(a);
  if (bytesToHex(digest) !== a.anchor.digest) {
    return {
      valid: false,
      status: a.anchor.status,
      reason: 'anchor digest does not match the attestation',
    };
  }
  if (a.anchor.provider !== provider.name) {
    return {
      valid: false,
      status: a.anchor.status,
      reason: `anchor was made by "${a.anchor.provider}", not "${provider.name}"`,
    };
  }
  return provider.verify(digest, a.anchor.proof);
}
