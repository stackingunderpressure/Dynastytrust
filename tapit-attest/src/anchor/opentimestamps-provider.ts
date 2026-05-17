/**
 * The real, Bitcoin-backed OtsProvider.
 *
 * Wraps the `opentimestamps` npm package -- an optional dependency,
 * loaded lazily so the rest of tapit-attest installs and runs
 * without it. `MockOtsProvider` (in core/anchor.ts) covers tests;
 * this is the production wiring.
 *
 * UNVERIFIED: exercising this requires reaching public OpenTimestamps
 * calendar servers and waiting for Bitcoin confirmation. The unit
 * suite cannot cover it. Treat the calendar interaction as untested
 * until run against the live network.
 */

import type { AnchorConfirmation, OtsProvider } from '../core/anchor.js';

type OtsModule = typeof import('opentimestamps');

async function loadOts(): Promise<OtsModule['default']> {
  try {
    const mod = (await import('opentimestamps')) as OtsModule;
    return mod.default;
  } catch {
    throw new Error(
      'OpenTimestampsProvider needs the optional "opentimestamps" package: npm install opentimestamps',
    );
  }
}

/** OtsProvider backed by public OpenTimestamps calendar servers. */
export class OpenTimestampsProvider implements OtsProvider {
  async stamp(digest: Uint8Array): Promise<Uint8Array> {
    const ots = await loadOts();
    const detached = ots.DetachedTimestampFile.fromHash(new ots.Ops.OpSHA256(), digest);
    await ots.stamp(detached);
    return detached.serializeToBytes();
  }

  async upgrade(proof: Uint8Array): Promise<Uint8Array> {
    const ots = await loadOts();
    const detached = ots.DetachedTimestampFile.deserialize(proof);
    await ots.upgrade(detached);
    return detached.serializeToBytes();
  }

  async verify(
    digest: Uint8Array,
    proof: Uint8Array,
  ): Promise<AnchorConfirmation | null> {
    const ots = await loadOts();
    const original = ots.DetachedTimestampFile.fromHash(new ots.Ops.OpSHA256(), digest);
    const detachedProof = ots.DetachedTimestampFile.deserialize(proof);
    const result = await ots.verify(detachedProof, original);
    const bitcoin = result?.['bitcoin'];
    if (bitcoin && typeof bitcoin.height === 'number') {
      return { bitcoinHeight: bitcoin.height };
    }
    return null;
  }
}
