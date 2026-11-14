import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Netlify sets COMMIT_REF (the full 40-char deploy commit SHA) as a
// build-time env var automatically -- no config needed on the Netlify
// side. Locally (no CI), there's no COMMIT_REF, so builds fall back to
// 'dev' rather than silently claiming to be some old commit.
const commitRef = process.env.COMMIT_REF;
const appVersion = commitRef ? commitRef.slice(0, 7) : 'dev';

export default defineConfig(({ mode }) => {
  // `vite build --mode download`: the downloaded desktop app
  // (src/lib/download.ts). Its own output folder (the desktop shell reads
  // dist-download/), and no request to Google Fonts -- the typefaces ship
  // inside it (src/assets/fonts/).
  const download = mode === 'download';
  const outDir = download ? 'dist-download' : 'dist';
  return {
  plugins: [
    react(),
    {
      name: 'download-no-google-fonts',
      transformIndexHtml(html: string) {
        if (!download) return html;
        return html.replace(/\s*<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>/g, '');
      },
      // The website build never loads the bundled typefaces (main.tsx only
      // imports them when DOWNLOAD), but Vite would still emit the font
      // files for that dead import: hand it an empty stylesheet instead.
      load(id: string) {
        if (!download && id.endsWith('/assets/fonts/download-fonts.css')) return '';
        return null;
      },
    },
    {
      // The app's own JS bundle only knows the version it was built
      // with (baked in via `define` below) -- it can't tell a running
      // tab that a NEWER version has since deployed. A separate static
      // file the running tab can re-fetch (bypassing whatever's in the
      // JS bundle cache) is what makes that check possible, so this
      // writes dist/version.json alongside the bundle at build end.
      name: 'write-version-json',
      closeBundle() {
        // Ensure dist/ exists -- closeBundle can run before Vite has
        // created the out dir in some environments, which made the build
        // fail with ENOENT on dist/version.json.
        mkdirSync(resolve(__dirname, outDir), { recursive: true });
        writeFileSync(
          resolve(__dirname, outDir, 'version.json'),
          JSON.stringify({ version: appVersion, builtAt: new Date().toISOString() }),
        );
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    outDir,
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
};
});
