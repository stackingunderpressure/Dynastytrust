#!/usr/bin/env node
/**
 * inject-config.js
 *
 * Runs at Netlify build time. Reads SUPABASE_URL and SUPABASE_ANON_KEY
 * from environment variables and injects them into site/index.html as
 * a <script> block before </head>.
 *
 * This means zero hardcoded credentials in source code — all values
 * come from Netlify Environment Variables at build time.
 *
 * Required Netlify env vars:
 *   SUPABASE_URL         — e.g. https://abcdefgh.supabase.co
 *   SUPABASE_ANON_KEY    — eyJ... (public anon key, safe to embed)
 *
 * Optional:
 *   API_BASE             — defaults to /api
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ── Read env vars ─────────────────────────────────────────────────────────────
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const API_BASE       = process.env.API_BASE || '/api';

if (!SUPABASE_URL) {
  console.error('❌  Missing env var: SUPABASE_URL');
  console.error('    Set it in Netlify: Site Settings → Environment Variables');
  process.exit(1);
}

if (!SUPABASE_ANON_KEY) {
  console.error('❌  Missing env var: SUPABASE_ANON_KEY');
  console.error('    Set it in Netlify: Site Settings → Environment Variables');
  process.exit(1);
}

// ── Read index.html ───────────────────────────────────────────────────────────
const htmlPath = resolve(root, 'site', 'index.html');
let html = readFileSync(htmlPath, 'utf8');

// ── Build config snippet ──────────────────────────────────────────────────────
// Values are JSON-encoded so they're safe regardless of special characters.
const snippet = `
  <!-- !! AUTO-INJECTED BY BUILD — DO NOT EDIT MANUALLY !! -->
  <script>
    window.__SUPABASE_URL__   = ${JSON.stringify(SUPABASE_URL)};
    window.__SUPABASE_ANON_KEY__ = ${JSON.stringify(SUPABASE_ANON_KEY)};
    window.__API_BASE__       = ${JSON.stringify(API_BASE)};
  </script>`;

// ── Inject before </head> ────────────────────────────────────────────────────
if (html.includes('<!-- !! AUTO-INJECTED BY BUILD')) {
  // Replace existing injection (idempotent re-runs)
  html = html.replace(
    /\n  <!-- !! AUTO-INJECTED[\s\S]*?<\/script>/,
    snippet
  );
} else {
  html = html.replace('</head>', snippet + '\n</head>');
}

// ── Write back ────────────────────────────────────────────────────────────────
writeFileSync(htmlPath, html, 'utf8');

console.log('✓ Config injected into site/index.html');
console.log(`  SUPABASE_URL:      ${SUPABASE_URL}`);
console.log(`  SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY.slice(0, 20)}…`);
console.log(`  API_BASE:          ${API_BASE}`);
