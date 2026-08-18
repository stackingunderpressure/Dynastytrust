// Minimal Node ESM resolve hook, used only by test scripts that import
// real apps/web/src TS modules directly (via --experimental-strip-types).
// tsconfig.json's moduleResolution "Bundler" lets app source use
// extensionless relative imports (e.g. './keystore'), matching Vite's own
// resolution -- but Node's native ESM resolver requires an explicit
// extension. This hook retries a failed relative import with '.ts'
// appended, so app source stays untouched and convention-correct; only
// the test runner needs to know how to find the file.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
