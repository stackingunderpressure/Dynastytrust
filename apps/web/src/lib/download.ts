// The download build (docs/download-and-run-build-note.md): DynastyTrust you
// download and run, one person, no server of ours. Built with
// `vite build --mode download` (apps/web/.env.download sets VITE_DOWNLOAD=1);
// the website build never sets it, so every branch on DOWNLOAD folds away.

// Spelled `import.meta.env.VITE_DOWNLOAD` (no `?.`) so Vite replaces it with
// a constant and the website build drops the local server entirely; the
// typeof guard keeps it safe under Node, where import.meta.env is absent.
export const DOWNLOAD: boolean = typeof import.meta.env !== 'undefined' && import.meta.env.VITE_DOWNLOAD === '1';

/** The desktop shell's one native command (desktop/src-tauri/src/main.rs). */
type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

let injected: Invoke | null = null;
/** Tests and the browser walk hand in a stand-in for the desktop shell. */
export function useInvoke(fn: Invoke | null): void {
  injected = fn;
}

export function desktopInvoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  if (injected) return injected(cmd, args);
  const internals = (globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__;
  if (!internals) return Promise.reject(new Error('This is not running inside the DynastyTrust desktop app.'));
  return internals.invoke(cmd, args);
}
