/**
 * Storage-agnostic sync.
 *
 * tapit-attest does not own a database. It defines `AttestationStore`
 * -- a tiny put/get/list/delete interface -- and everything else
 * (Supabase, IndexedDB, a flat file, a peer's store) implements it.
 *
 * Two design rules carried in from the resilience goal:
 *
 *  1. Dual storage. Every attestation lives in at least two stores
 *     (typically a local store and a remote one). `SyncEngine`
 *     copies records both directions so neither side is a single
 *     point of failure -- the groundwork for peer rebuild
 *     (see recovery.ts).
 *
 *  2. Self-verifying records. A record is never trusted because of
 *     where it came from. `loadVerified` re-checks the envelope's
 *     structure and every signature on read, so a compromised store
 *     cannot inject a forged attestation.
 */

import { assertWellFormed, envelopeId, type AttestationEnvelope } from './envelope.js';
import { verifyEnvelope } from './sign.js';
import type { EncryptedBlob } from './encryption.js';

export interface StoredAttestation {
  /** envelopeId of `envelope`. */
  readonly id: string;
  readonly envelope: AttestationEnvelope;
  /** Optional client-side-encrypted copy for zero-knowledge backends. */
  readonly encrypted: EncryptedBlob | null;
  readonly updatedAt: string;
}

export interface AttestationStore {
  put(record: StoredAttestation): Promise<void>;
  get(id: string): Promise<StoredAttestation | null>;
  list(): Promise<readonly StoredAttestation[]>;
  delete(id: string): Promise<void>;
}

/** Wrap an envelope into a storable record. */
export function toRecord(
  envelope: AttestationEnvelope,
  encrypted: EncryptedBlob | null = null,
): StoredAttestation {
  return {
    id: envelopeId(envelope),
    envelope,
    encrypted,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Read a record and re-verify it. Returns null if the record is
 * missing, malformed, or carries an invalid signature -- callers
 * never have to trust the store.
 */
export async function loadVerified(
  store: AttestationStore,
  id: string,
): Promise<StoredAttestation | null> {
  const record = await store.get(id);
  if (!record) return null;
  try {
    assertWellFormed(record.envelope);
  } catch {
    return null;
  }
  if (envelopeId(record.envelope) !== record.id) return null;
  if (!verifyEnvelope(record.envelope).valid) return null;
  return record;
}

/** In-memory `AttestationStore` -- the default for tests and local dev. */
export class MemoryStore implements AttestationStore {
  private readonly records = new Map<string, StoredAttestation>();

  put(record: StoredAttestation): Promise<void> {
    this.records.set(record.id, record);
    return Promise.resolve();
  }

  get(id: string): Promise<StoredAttestation | null> {
    return Promise.resolve(this.records.get(id) ?? null);
  }

  list(): Promise<readonly StoredAttestation[]> {
    return Promise.resolve([...this.records.values()]);
  }

  delete(id: string): Promise<void> {
    this.records.delete(id);
    return Promise.resolve();
  }
}

export interface SyncReport {
  readonly pushed: number;
  readonly pulled: number;
  /** Ids skipped because the record failed verification. */
  readonly rejected: readonly string[];
}

/**
 * Copies verified records between a local and a remote store in both
 * directions. Last-write-wins on `updatedAt`.
 *
 * Richer conflict handling (per-field merge, vector clocks) is a
 * named v1.1 slot -- v1 intentionally keeps reconciliation simple.
 */
export class SyncEngine {
  constructor(
    private readonly local: AttestationStore,
    private readonly remote: AttestationStore,
  ) {}

  private static newer(a: StoredAttestation, b: StoredAttestation): boolean {
    return Date.parse(a.updatedAt) > Date.parse(b.updatedAt);
  }

  private async copy(
    from: AttestationStore,
    to: AttestationStore,
    rejected: string[],
  ): Promise<number> {
    let count = 0;
    for (const record of await from.list()) {
      const verified = await loadVerified(from, record.id);
      if (!verified) {
        rejected.push(record.id);
        continue;
      }
      const existing = await to.get(verified.id);
      if (!existing || SyncEngine.newer(verified, existing)) {
        await to.put(verified);
        count++;
      }
    }
    return count;
  }

  /** Push local -> remote, pull remote -> local. */
  async sync(): Promise<SyncReport> {
    const rejected: string[] = [];
    const pushed = await this.copy(this.local, this.remote, rejected);
    const pulled = await this.copy(this.remote, this.local, rejected);
    return { pushed, pulled, rejected };
  }
}
