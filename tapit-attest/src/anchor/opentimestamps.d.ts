/**
 * Minimal ambient typing for the `opentimestamps` npm package.
 *
 * The package ships no types. We declare only the surface the
 * `OpenTimestampsProvider` touches so the library typechecks whether
 * or not the optional dependency is installed.
 */
declare module 'opentimestamps' {
  interface DetachedFile {
    serializeToBytes(): Uint8Array;
  }
  interface DetachedFileStatic {
    fromHash(op: object, hash: Uint8Array): DetachedFile;
    deserialize(bytes: Uint8Array): DetachedFile;
  }
  interface OpSHA256Static {
    new (): object;
  }
  interface VerifyChainResult {
    readonly timestamp?: number;
    readonly height?: number;
  }
  interface OpenTimestampsApi {
    readonly DetachedTimestampFile: DetachedFileStatic;
    readonly Ops: { readonly OpSHA256: OpSHA256Static };
    stamp(detached: DetachedFile): Promise<void>;
    upgrade(detached: DetachedFile): Promise<boolean>;
    verify(
      detachedProof: DetachedFile,
      detachedOriginal: DetachedFile,
    ): Promise<Record<string, VerifyChainResult> | undefined>;
  }
  const api: OpenTimestampsApi;
  export default api;
}
