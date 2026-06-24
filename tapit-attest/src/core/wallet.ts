import type { Attestation } from '../types.js';
import { createDraft, type DraftInput } from './envelope.js';
import {
  generateKeypair,
  signDigest as signDigestPrimitive,
  signEnvelope,
  verifyEnvelope,
  type Keypair,
} from './keys.js';
import { encryptTo, decryptFrom } from './nip44.js';
import {
  createSuccessionLink,
  verifySuccessionChain,
  type SuccessionLink,
} from './succession.js';
import { decryptToString, encrypt, type EncryptedBlob } from './encryption.js';
import {
  encryptRecoverable,
  encryptRecoverableWithKData,
  decryptRecoverableWithPassphrase,
  decryptRecoverableWithKData,
  reencryptRecoverableReuseKData,
  unwrapKData,
  type RecoverableEncryptedBlob,
  type RecoverableEncryptionResult,
} from './encryption.js';
import {
  MemoryStore,
  SyncEngine,
  loadVerified,
  toRecord,
  type AttestationStore,
  type SyncResult,
} from './sync.js';
import {
  buildRecoveryRequest,
  buildRecoveryResponse,
  verifyRecoveryResponse,
  type RecoveryRequest,
  type RecoveryResponse,
} from './recovery.js';

/**
 * The serializable whole of a wallet — keys, key history, and every
 * attestation held. This is what an encrypted backup contains and what a
 * recovery rebuilds toward.
 */
export interface WalletSnapshot {
  v: 1;
  /** The genesis public key — the wallet's stable identity across rotation. */
  identity: string;
  /** The current active keypair. */
  activeKeypair: Keypair;
  /** Key-succession history; empty until the first rotation. */
  succession: SuccessionLink[];
  /**
   * Keypairs the wallet has retired through rotation, oldest first.
   * Retained so the wallet can still DECRYPT messages a peer addressed
   * to a pre-rotation key — a peer who connected before the rotation
   * keeps sending to the old key until they learn of the new one, and
   * without the old PRIVATE key those messages are permanently
   * unreadable (NIP-44 decryption needs the recipient's private key).
   * Optional for backward compatibility: snapshots written before this
   * field existed simply have no retired keypairs, and a wallet that
   * has never rotated has none either. Encrypted at rest exactly like
   * activeKeypair — these never leave the device unencrypted (D-03).
   */
  retiredKeypairs?: Keypair[];
  /** Every attestation the wallet holds. */
  holdings: Attestation[];
}

/**
 * A person's sovereign identity wallet. It generates and holds the
 * keypair, coordinates key rotation through a succession chain, and is
 * the Merkle holder of the attestations that make up a reputation. Other
 * programs sign through it (`attest` / `sign`) and hand it claims to hold
 * (`hold`) — signing works both ways: claims the wallet makes about
 * others, and claims others make about the wallet.
 *
 * The wallet is the unit of sovereignty. The host is dumb storage; peers
 * are redundancy; the keys never leave the wallet unencrypted. Built on
 * the tapit-attest primitives — this object is the coordinator that makes
 * them feel like one thing a person owns.
 */
export class Wallet {
  // Hard-private with the JS # field — not just TS-private. A Wallet's
  // keypair must be unreachable from any code that holds a Wallet
  // reference (a bug, a debug log, a third-party module evaluated in
  // the same context). D-03: keys never leave the wallet unencrypted.
  // The escape hatches are explicit: snapshot() / exportEncrypted().
  #keypair: Keypair;
  // Private keys of every retired (pre-rotation) signing key, oldest
  // first. Hard-private with the JS # field for the same reason as
  // #keypair — old private keys are as sensitive as the active one and
  // must be unreachable from any code holding a Wallet reference. They
  // exist so the wallet can still decrypt messages addressed to a key
  // it has since rotated away from.
  #retiredKeypairs: Keypair[];
  private readonly _identity: string;
  private readonly succession: SuccessionLink[];
  private readonly store: AttestationStore;

  constructor(config: {
    keypair: Keypair;
    /** The genesis identity key; defaults to the keypair's public key. */
    identity?: string;
    succession?: SuccessionLink[];
    /** Pre-rotation keypairs retained for decrypting old messages. */
    retiredKeypairs?: Keypair[];
    store?: AttestationStore;
  }) {
    this.#keypair = config.keypair;
    this.#retiredKeypairs = config.retiredKeypairs ? [...config.retiredKeypairs] : [];
    this._identity = config.identity ?? config.keypair.publicKey;
    this.succession = config.succession ?? [];
    this.store = config.store ?? new MemoryStore();
  }

  /** Create a wallet with a fresh keypair. */
  static generate(store?: AttestationStore): Wallet {
    return new Wallet({ keypair: generateKeypair(), store });
  }

  /** Wrap an existing keypair as a wallet. */
  static fromKeypair(keypair: Keypair, store?: AttestationStore): Wallet {
    return new Wallet({ keypair, store });
  }

  /** The current active signing key. */
  get publicKey(): string {
    return this.#keypair.publicKey;
  }

  /**
   * The wallet's stable identity — its genesis public key. This is what
   * "you" means even after the active signing key has been rotated; the
   * succession chain proves the link from identity to the active key.
   */
  get identity(): string {
    return this._identity;
  }

  /** Every public key this wallet has ever used, oldest first. */
  get keyHistory(): string[] {
    return [...new Set([this._identity, ...this.succession.map((l) => l.toKey)])];
  }

  /** The key-succession chain. Empty until the first rotation. */
  get successionChain(): SuccessionLink[] {
    return [...this.succession];
  }

  // --- issuing attestations (signing as the signer) ---

  /** Create an attestation and sign it with the active key, in one step. */
  attest(input: DraftInput): Attestation {
    return signEnvelope(createDraft(input), this.#keypair.privateKey);
  }

  /**
   * Add this wallet's signature to an existing attestation — countersign
   * a multi-party agreement, or sign a draft another party built. Signing
   * works both ways: claims this wallet makes, and claims made about it.
   */
  sign(attestation: Attestation): Attestation {
    return signEnvelope(attestation, this.#keypair.privateKey);
  }

  // --- low-level signing for non-envelope payloads ---

  /**
   * Sign an arbitrary 32-byte digest with the active key. Used for
   * signing Nostr event ids and other non-envelope payloads. The
   * envelope path stays through sign / attest — this is the seam the
   * peer-transport layer needs without leaking the private key.
   */
  signDigest(digest: Uint8Array): string {
    return signDigestPrimitive(digest, this.#keypair.privateKey);
  }

  // --- peer encryption (NIP-44 v2) ---

  /**
   * Encrypt a string to a peer's x-only public key, with this wallet
   * as the sender. Returns a base64 NIP-44 v2 payload. The wallet's
   * private key never crosses the method boundary — only the result.
   */
  nip44EncryptTo(plaintext: string, recipientPubkey: string): string {
    return encryptTo(plaintext, recipientPubkey, this.#keypair.privateKey);
  }

  /**
   * Decrypt a NIP-44 v2 payload sent to this wallet from a peer's
   * x-only public key. Throws on MAC failure — which catches a
   * tampered payload, a wrong-sender claim, or a mis-routed message.
   */
  nip44DecryptFrom(payload: string, senderPubkey: string): string {
    return decryptFrom(payload, senderPubkey, this.#keypair.privateKey);
  }

  /**
   * Decrypt a NIP-44 v2 payload addressed to ANY key this wallet has
   * ever held — the active key first, then each retired key newest to
   * oldest. Returns the first successful decryption; throws only if no
   * key opens it.
   *
   * This is the rotation-safe receive path. A peer who connected before
   * the wallet rotated still addresses messages to the pre-rotation
   * key, and NIP-44 decryption needs the matching private key — so
   * after a rotation nip44DecryptFrom (active key only) would throw
   * MAC-failure on every such message and they would be silently lost.
   * Trying the retired keys recovers them. The order (active first)
   * means the common case — a message to the current key — succeeds on
   * the first try with no extra work.
   */
  nip44DecryptFromAnyKey(payload: string, senderPubkey: string): string {
    const candidates = [
      this.#keypair.privateKey,
      ...[...this.#retiredKeypairs].reverse().map((k) => k.privateKey),
    ];
    let lastErr: unknown;
    for (const priv of candidates) {
      try {
        return decryptFrom(payload, senderPubkey, priv);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('decryption failed under every key in this wallet');
  }

  // --- holding attestations (the Merkle holder) ---

  /**
   * Verify an attestation and add it to the wallet's holdings. Throws if
   * the attestation does not verify — the wallet never holds a claim it
   * cannot prove.
   */
  async hold(attestation: Attestation): Promise<void> {
    if (!verifyEnvelope(attestation).valid) {
      throw new Error('cannot hold an attestation that does not verify');
    }
    await this.store.put(toRecord(attestation));
  }

  /**
   * Remove an attestation from the wallet's holdings by its envelope
   * id. No-op when the id is not held. This is local-only — the
   * envelope still exists for anyone else who holds a copy; only
   * this wallet's view changes. Used by the operator-facing
   * "leave organization" and "delete organization" affordances, and
   * by any future "tidy up old envelopes" surface.
   */
  async unhold(envelopeId: string): Promise<void> {
    await this.store.delete(envelopeId);
  }

  /** Every held attestation whose signatures verify. */
  async holdings(): Promise<Attestation[]> {
    return loadVerified(this.store);
  }

  /** Held attestations where this wallet is the subject. */
  async aboutMe(): Promise<Attestation[]> {
    const mine = new Set(this.keyHistory);
    return (await this.holdings()).filter((a) => mine.has(a.subject));
  }

  /** Held attestations this wallet signed. */
  async issuedByMe(): Promise<Attestation[]> {
    const mine = new Set(this.keyHistory);
    return (await this.holdings()).filter((a) =>
      a.signatures.some((s) => mine.has(s.signer)),
    );
  }

  // --- key succession ---

  /**
   * Rotate to a fresh signing key. The retiring key signs a succession
   * link binding it to the new one, so reputation earned under the old
   * key carries forward. Mutates the wallet; returns the new link.
   */
  rotate(): SuccessionLink {
    const next = generateKeypair();
    const link = createSuccessionLink({
      fromPrivateKey: this.#keypair.privateKey,
      toKey: next.publicKey,
      previous: this.succession[this.succession.length - 1],
    });
    this.succession.push(link);
    // Retain the retiring keypair (private key included) so the wallet
    // can still decrypt messages peers addressed to it before they
    // learned of the rotation. Push BEFORE replacing #keypair so the
    // about-to-be-retired key is captured. Retaining old keys does not
    // weaken security: if a rotation was prompted by a key compromise,
    // the attacker already has the old key, and the new key is what
    // protects future messages — this is the same posture every
    // messenger that keeps old keys to read old messages takes.
    this.#retiredKeypairs.push(this.#keypair);
    this.#keypair = next;
    return link;
  }

  /** Verify the succession chain resolves from the identity to the active key. */
  verifyKeyHistory(): boolean {
    if (this.succession.length === 0) return this._identity === this.publicKey;
    const result = verifySuccessionChain(this.succession);
    return (
      result.valid &&
      result.currentKey === this.publicKey &&
      this.succession[0].fromKey === this._identity
    );
  }

  // --- backup ---

  /** Serialize the full wallet — keys, succession, holdings — to a snapshot. */
  async snapshot(): Promise<WalletSnapshot> {
    return {
      v: 1,
      identity: this._identity,
      activeKeypair: this.#keypair,
      succession: [...this.succession],
      retiredKeypairs: [...this.#retiredKeypairs],
      holdings: await this.holdings(),
    };
  }

  /**
   * Encrypt the whole wallet for backup. The blob is ciphertext a host
   * cannot read — the wallet is encrypted client-side before it ever
   * leaves the device.
   */
  async exportEncrypted(password: string): Promise<EncryptedBlob> {
    return encrypt(JSON.stringify(await this.snapshot()), password);
  }

  /** Rebuild a wallet from a snapshot (decrypted backup, or recovery output). */
  static async fromSnapshot(
    snapshot: WalletSnapshot,
    store?: AttestationStore,
  ): Promise<Wallet> {
    const wallet = new Wallet({
      keypair: snapshot.activeKeypair,
      identity: snapshot.identity,
      succession: snapshot.succession,
      retiredKeypairs: snapshot.retiredKeypairs,
      store,
    });
    for (const attestation of snapshot.holdings) {
      if (verifyEnvelope(attestation).valid) {
        await wallet.store.put(toRecord(attestation));
      }
    }
    return wallet;
  }

  /** Restore a wallet from an encrypted backup blob. */
  static async restore(
    blob: EncryptedBlob,
    password: string,
    store?: AttestationStore,
  ): Promise<Wallet> {
    const snapshot = JSON.parse(decryptToString(blob, password)) as WalletSnapshot;
    return Wallet.fromSnapshot(snapshot, store);
  }

  /**
   * Encrypt the wallet using the v2 recoverable backup format. Returns
   * the blob plus K_data — the freshly-random data-encryption key. The
   * caller is expected to either Shamir-split K_data across cohort peers
   * and distribute the shares (Phase 5e cascade recovery) or discard it.
   *
   * K_data MUST NOT be retained on the producing device after share
   * distribution — the security of the recovery cascade relies on the
   * device that minted K_data forgetting it. The blob remains
   * decryptable with the passphrase regardless.
   */
  async exportRecoverable(passphrase: string): Promise<RecoverableEncryptionResult> {
    return encryptRecoverable(JSON.stringify(await this.snapshot()), passphrase);
  }

  /**
   * Restore a wallet from a v2 recoverable backup using the passphrase.
   * Equivalent to `restore` for v1, but reads the v2 blob shape.
   */
  static async restoreRecoverable(
    blob: RecoverableEncryptedBlob,
    passphrase: string,
    store?: AttestationStore,
  ): Promise<Wallet> {
    const bytes = decryptRecoverableWithPassphrase(blob, passphrase);
    const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as WalletSnapshot;
    return Wallet.fromSnapshot(snapshot, store);
  }

  /**
   * Restore a wallet from a v2 recoverable backup using a K_data
   * reconstructed from M cohort peer shares. This is the Phase 5e
   * recovery path — no passphrase needed because the operator has
   * proved threshold cooperation from their peer network instead.
   */
  static async restoreFromKData(
    blob: RecoverableEncryptedBlob,
    kData: Uint8Array,
    store?: AttestationStore,
  ): Promise<Wallet> {
    const bytes = decryptRecoverableWithKData(blob, kData);
    const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as WalletSnapshot;
    return Wallet.fromSnapshot(snapshot, store);
  }

  /**
   * Re-encrypt the wallet under the SAME K_data already wrapped in an
   * existing v2 blob. Subsequent saves after shares have been
   * distributed MUST use this path — generating a fresh K_data per
   * save would silently invalidate every share the cohort holds. The
   * returned result carries kData (the same one unwrapped from the
   * old blob) so the share-distribution flow can verify it hasn't
   * drifted from a previously-cached value.
   */
  async exportRecoverableReuseKData(
    oldBlob: RecoverableEncryptedBlob,
    passphrase: string,
  ): Promise<RecoverableEncryptionResult> {
    const json = JSON.stringify(await this.snapshot());
    const blob = reencryptRecoverableReuseKData(oldBlob, json, passphrase);
    const kData = unwrapKData(oldBlob, passphrase);
    return { blob, kData };
  }

  /**
   * Re-encrypt the wallet snapshot using a CALLER-supplied K_data and
   * wrap it under a fresh passphrase. The Phase 5e recovery seam: the
   * new device has reconstructed K_data from M cohort shares and
   * restored this wallet via restoreFromKData; the operator now picks
   * a new passphrase on the new device and saves under it. K_data is
   * preserved so the cohort's already-distributed shares stay valid
   * against the new blob, and the new blob's passphrase-wrap is for
   * the new passphrase the operator just chose.
   */
  async exportRecoverableWithKData(
    kData: Uint8Array,
    passphrase: string,
  ): Promise<RecoverableEncryptedBlob> {
    return encryptRecoverableWithKData(
      JSON.stringify(await this.snapshot()),
      kData,
      passphrase,
    );
  }

  // --- sync ---

  /**
   * Reconcile this wallet's holdings with a remote store (last-write-wins).
   * The remote is dumb storage — it sees attestation records, each
   * self-verifying, never the wallet's keys.
   */
  async sync(remote: AttestationStore): Promise<SyncResult> {
    return new SyncEngine(this.store, remote).sync();
  }

  // --- recovery ---

  /** Build a signed request asking peers to return this wallet's attestations. */
  recoveryRequest(): RecoveryRequest {
    return buildRecoveryRequest({
      subject: this._identity,
      requesterPrivateKey: this.#keypair.privateKey,
    });
  }

  /**
   * Answer another wallet's recovery request — return every attestation
   * this wallet holds that involves the requester. Every wallet is a peer
   * for every other; this mutual redundancy is what makes a lost wallet
   * rebuildable.
   */
  async answerRecovery(request: RecoveryRequest): Promise<RecoveryResponse> {
    return buildRecoveryResponse({
      request,
      store: this.store,
      responderPrivateKey: this.#keypair.privateKey,
    });
  }

  /**
   * Rebuild a wallet's holdings from peer recovery responses. Each
   * returned attestation is self-verifying, so the rebuilt wallet is
   * trustless regardless of peer honesty. The caller supplies the keypair
   * for the rebuilt wallet — recovering the attestation history is
   * separate from recovering the signing key (identity recovery, via
   * succession + social vouching, is a later-spec concern).
   */
  static async recoverHoldings(
    keypair: Keypair,
    identity: string,
    responses: RecoveryResponse[],
    store?: AttestationStore,
  ): Promise<Wallet> {
    const wallet = new Wallet({ keypair, identity, store });
    for (const response of responses) {
      for (const attestation of verifyRecoveryResponse(response).attestations) {
        await wallet.store.put(toRecord(attestation));
      }
    }
    return wallet;
  }
}
