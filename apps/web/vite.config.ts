import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Netlify sets COMMIT_REF (the full 40-char deploy commit SHA) as a
// build-time env var automatically -- no config needed on the Netlify
// side. Locally (no CI), there's no COMMIT_REF, so builds fall back to
// 'dev' rather than silently claiming to be some old commit.
const commitRef = process.env.COMMIT_REF;
const appVersion = commitRef ? commitRef.slice(0, 7) : 'dev';

export default defineConfig({
  plugins: [
    react(),
    {
      // The app's own JS bundle only knows the version it was built
      // with (baked in via `define` below) -- it can't tell a running
      // tab that a NEWER version has since deployed. A separate static
      // file the running tab can re-fetch (bypassing whatever's in the
      // JS bundle cache) is what makes that check possible, so this
      // writes dist/version.json alongside the bundle at build end.
      name: 'write-version-json',
      closeBundle() {
        writeFileSync(
          resolve(__dirname, 'dist/version.json'),
          JSON.stringify({ version: appVersion, builtAt: new Date().toISOString() }),
        );
      },
    },
    {
      // Self-hosted Subresource Integrity. Vite content-hashes the bundle's
      // filename (index-XXXX.js) for cache-busting, but that's just a
      // naming convention -- nothing stops a compromised CDN edge node or a
      // MITM from serving different bytes under that same filename. Writing
      // a real integrity hash into index.html's own <script>/<link> tags
      // means the BROWSER itself refuses to execute a file whose bytes
      // don't match, even if something tampers with what's served after
      // this build produced it. closeBundle fires once the whole write
      // phase is done (Rollup hook semantics), so dist/index.html and every
      // referenced asset are guaranteed on disk regardless of this
      // plugin's position in the array.
      name: 'inject-sri',
      closeBundle() {
        const distDir = resolve(__dirname, 'dist');
        const indexPath = resolve(distDir, 'index.html');
        let html = readFileSync(indexPath, 'utf-8');

        const integrityFor = (assetPath: string) => {
          const bytes = readFileSync(resolve(distDir, '.' + assetPath));
          return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
        };

        // <script type="module" crossorigin src="/assets/xxx.js"></script>
        html = html.replace(
          /<script([^>]*?)\ssrc="(\/assets\/[^"]+\.js)"([^>]*)>/g,
          (match, before, src, after) =>
            /integrity=/.test(match) ? match : `<script${before} src="${src}" integrity="${integrityFor(src)}"${after}>`,
        );

        // <link rel="stylesheet" crossorigin href="/assets/xxx.css">
        html = html.replace(
          /<link([^>]*?)\shref="(\/assets\/[^"]+\.css)"([^>]*)>/g,
          (match, before, href, after) =>
            /integrity=/.test(match) ? match : `<link${before} href="${href}" integrity="${integrityFor(href)}"${after}>`,
        );

        writeFileSync(indexPath, html);
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    rollupOptions: {
      // tapit-attest's barrel re-exports OpenTimestampsProvider, which holds
      // a dynamic import('opentimestamps') inside a function body -- never
      // called from this app (nothing here anchors to OpenTimestamps; that
      // is a tapit-wallet feature). The installed opentimestamps package
      // ships a broken `main` field (declares open-timestamps.js; the
      // published package only contains index.js), which Rollup's resolver
      // (unlike Node's own CJS fallback-to-index.js behavior) refuses to
      // paper over when trying to give the dynamic import its own chunk.
      // Externalizing it here is correct either way: this app never
      // executes that code path, so there is nothing to bundle.
      external: ['opentimestamps'],
    },
  },
});
