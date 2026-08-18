// Registers ts-resolve-loader.mjs via the stable node:module register()
// API (--experimental-loader is flagged for eventual removal). Imported
// via `node --import` ahead of a test script that needs to resolve real
// apps/web/src TS modules directly.
import { register } from 'node:module';

register('./ts-resolve-loader.mjs', import.meta.url);
