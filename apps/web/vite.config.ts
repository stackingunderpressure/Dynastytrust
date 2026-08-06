import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
