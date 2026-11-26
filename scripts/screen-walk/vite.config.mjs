// The real web app's Vite config, with one swap: the opentimestamps package
// (which does not bundle for a dev server) is replaced by an empty stub.
// Used only by the screen walk (scripts/screen-walk/walk.cjs).
import { fileURLToPath } from 'node:url';
import base from '../../apps/web/vite.config.ts';
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export default (env) => {
  const c = typeof base === 'function' ? base(env) : base;
  return { ...c, root: here('../../apps/web'),
    resolve: { ...(c.resolve || {}), alias: { ...((c.resolve || {}).alias || {}), opentimestamps: here('./ots-stub.js') } },
    server: { fs: { allow: [here('../..')] } } };
};
