// The vault compiler, run ON THIS DEVICE (sovereign slice 1,
// docs/super-sovereign-build-note.md). Operator's chips, 2026-11-13:
// groundwork only -- the live site keeps using the Fly compiler for now --
// and load it only when a vault is built or spent.
//
// compiler-wasm/ runs dynastytrust_protocol::service, the SAME code the Fly
// server runs behind its shared secret, built to WebAssembly and committed
// as lib/wasm/dynastytrust_compiler_wasm.wasm. scripts/test-compiler-wasm.mjs
// holds that file to its Rust source and replays every recorded answer of
// the server through THIS loader. Same request JSON in, same status and
// response JSON out as POST <compiler>/<endpoint>.

interface CompilerExports {
  memory: WebAssembly.Memory;
  dt_alloc(len: number): number;
  dt_dealloc(ptr: number, cap: number): void;
  dt_handle(epPtr: number, epLen: number, bodyPtr: number, bodyLen: number): number;
}

export type CompilerEndpoint =
  | '/compile' | '/compile-bloc' | '/compile-tranche' | '/compile-leaves'
  | '/psbt-binary' | '/psbt-binary-bloc' | '/psbt-binary-tranche'
  | '/psbt-finalize' | '/psbt-merge'
  | '/governance/status' | '/governance/audit' | '/validate-address';

let loading: Promise<CompilerExports> | null = null;
let injected: Uint8Array | null = null;

/** Tests (Node) hand in the committed .wasm bytes; the browser fetches it. */
export function useCompilerWasmBytes(bytes: Uint8Array): void {
  injected = bytes;
  loading = null;
}

function load(): Promise<CompilerExports> {
  if (!loading) {
    loading = (async () => {
      const bytes = injected ?? new Uint8Array(await (await fetch(new URL('./wasm/dynastytrust_compiler_wasm.wasm', import.meta.url))).arrayBuffer());
      const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
      return instance.exports as unknown as CompilerExports;
    })();
    loading.catch(() => { loading = null; }); // a failed load can be retried
  }
  return loading;
}

/**
 * Answer one compiler request on this device: the HTTP status and the exact
 * response text the Fly server would have sent for the same request.
 */
export async function compileOnDevice(endpoint: CompilerEndpoint, request: unknown): Promise<{ status: number; body: string }> {
  const x = await load();
  const enc = new TextEncoder();
  const e = enc.encode(endpoint), b = enc.encode(JSON.stringify(request));
  const ep = x.dt_alloc(e.length), bp = x.dt_alloc(b.length);
  new Uint8Array(x.memory.buffer, ep, e.length).set(e);
  new Uint8Array(x.memory.buffer, bp, b.length).set(b);
  const rp = x.dt_handle(ep, e.length, bp, b.length);
  x.dt_dealloc(ep, e.length);
  x.dt_dealloc(bp, b.length);
  const len = new DataView(x.memory.buffer).getUint32(rp, true);
  const json = new TextDecoder().decode(new Uint8Array(x.memory.buffer, rp + 4, len));
  x.dt_dealloc(rp, 4 + len);
  const v = JSON.parse(json) as { status: number; body: string };
  return { status: v.status, body: v.body };
}
