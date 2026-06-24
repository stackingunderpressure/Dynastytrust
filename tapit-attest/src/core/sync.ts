import type { Attestation } from '../types.js';
import { envelopeId } from './envelope.js';
import { verifyEnvelope } from './keys.js';

/**
 * A stored attestation. Indexed by subject AND by every signer, so the
 * same record is reachable from both the subject's view and each
 * signer's view — the dual storage that makes peer-rebuild recovery
 * possible (ATTESTATION_PRIMITIVE_SPEC §4).
 */
export interface AttestationRecord {
  id: string;
  subject: string;
  signers: string[];
  /** ISO 8601 — drives last-write-wins reconciliation. */
  updatedAt: string;
  envelope: Attestation;
}

/** Wrap an attestation as a storable record. */
export function toRecord(a: Attestation, updatedAt?: string): AttestationRecord {
  return {
    id: envelopeId(a),
    subject: a.subject,
    signers: [...new Set(a.signatures.map((s) => s.signer))],
    updatedAt: updatedAt ?? new Date().toISOString(),
    envelope: a,
  };
}

/**
 * Storage-agnostic attestation store. The in-memory implementation ships
 * with the library; a Supabase-backed implementation (or any other) just
 * has to satisfy this interface — the host is dumb storage, never a
 * trusted party.
 */
export interface AttestationStore {
  get(id: string): Promise<AttestationRecord | null>;
  put(record: AttestationRecord): Promise<void>;
  /** Remove the record with the given id. No-op when the id is not present. */
  delete(id: string): Promise<void>;
  list(): Promise<AttestationRecord[]>;
  bySubject(subject: string): Promise<AttestationRecord[]>;
  bySigner(signer: string): Promise<AttestationRecord[]>;
}

/** In-memory AttestationStore — the reference implementation and test double. */
export class MemoryStore implements AttestationStore {
  private readonly records = new Map<string, AttestationRecord>();

  async get(id: string): Promise<AttestationRecord | null> {
    return this.records.get(id) ?? null;
  }

  async put(record: AttestationRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  async list(): Promise<AttestationRecord[]> {
    return [...this.records.values()];
  }

  async bySubject(subject: string): Promise<AttestationRecord[]> {
    return (await this.list()).filter((r) => r.subject === subject);
  }

  async bySigner(signer: string): Promise<AttestationRecord[]> {
    return (await this.list()).filter((r) => r.signers.includes(signer));
  }
}

export interface SyncResult {
  pushed: number;
  pulled: number;
}

/**
 * Reconciles a local and a remote store. v1 is last-write-wins by
 * `updatedAt` — the record with the newer timestamp survives on both
 * sides. Per-field merge / vector clocks are the v1.1 slot.
 */
export class SyncEngine {
  constructor(
    private readonly local: AttestationStore,
    private readonly remote: AttestationStore,
  ) {}

  /** Push local→remote, then pull remote→local. */
  async sync(): Promise<SyncResult> {
    const pushed = await this.reconcile(this.local, this.remote);
    const pulled = await this.reconcile(this.remote, this.local);
    return { pushed, pulled };
  }

  /** Copy newer records local→remote. Returns the count written. */
  async push(): Promise<number> {
    return this.reconcile(this.local, this.remote);
  }

  /** Copy newer records remote→local. Returns the count written. */
  async pull(): Promise<number> {
    return this.reconcile(this.remote, this.local);
  }

  private async reconcile(from: AttestationStore, to: AttestationStore): Promise<number> {
    let written = 0;
    for (const record of await from.list()) {
      const existing = await to.get(record.id);
      if (!existing || Date.parse(record.updatedAt) > Date.parse(existing.updatedAt)) {
        await to.put(record);
        written++;
      }
    }
    return written;
  }
}

/**
 * Load only the attestations whose signatures all verify. The store is
 * dumb storage — trust nothing it returns until the envelope verifies
 * itself.
 */
export async function loadVerified(store: AttestationStore): Promise<Attestation[]> {
  const verified: Attestation[] = [];
  for (const record of await store.list()) {
    if (verifyEnvelope(record.envelope).valid) verified.push(record.envelope);
  }
  return verified;
}
