/**
 * _compiler.js -- shared fetch-with-timeout-and-retry for calls to the
 * Fly.io Rust compiler service.
 *
 * This scaffolding (AbortController timeout + a retry with backoff, to
 * ride out the compiler's cold start after idling) was independently
 * copy-pasted into compile.js and compile-bloc.js, while
 * compile-tranche.js, vaults-compile.js, and vaults-compile-bloc.js
 * each grew their own copy of just the timeout half and never got the
 * retry -- three call sites silently missing the exact resilience the
 * other two were built for. One shared implementation now backs all
 * five, so "does this endpoint retry a cold compiler" isn't a
 * per-file accident anymore.
 *
 * Handles only the network transport (timeout + retry); each caller
 * keeps its own response-parsing and error-shaping, since those
 * genuinely differ (e.g. compile.js's non-JSON-response hint text).
 */

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 3000;

/**
 * POST to a compiler endpoint with a timeout and a retry (to ride out
 * the compiler waking up from a cold start). Returns the raw fetch
 * Response on success; throws the last error if every attempt fails
 * (an AbortError on timeout, or the underlying network error).
 */
export async function fetchCompiler(compilerUrl, path, body, {
  compilerSecret,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${compilerUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(compilerSecret ? { Authorization: `Bearer ${compilerSecret}` } : {}),
        },
        body: JSON.stringify(body),
      });
      return res;
    } catch (err) {
      lastErr = err;
      console.error(`Compiler attempt ${attempt} failed:`, err.message);
      if (attempt < retries) await new Promise((r) => setTimeout(r, retryDelayMs));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr;
}

/** Human-readable reason for a fetchCompiler failure -- distinguishes a timeout from any other network error. */
export function compilerFailureReason(err, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return err?.name === 'AbortError'
    ? `Compiler timed out after ${timeoutMs / 1000}s`
    : err?.message || 'Unknown error';
}
