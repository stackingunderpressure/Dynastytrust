# Dynastytrust Deploy Notes

## What is included
- `apps/web` — Vite React frontend
- `netlify/functions` — serverless backend (vaults, PSBTs, governance, balance, compile)
- `packages/policy-engine` — shared policy validation package
- `compiler` — optional Rust policy compiler (deploy to Fly.io)
- `db/migrations` — Supabase/Postgres schema

## Local development
```bash
npm install
cp apps/web/.env.example apps/web/.env
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install -g netlify-cli
netlify dev
```

Set backend env vars (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) in a root
`.env` or via `netlify env:set` before running `netlify dev`.

## Tests
```bash
npm test
```

Runs policy-engine validation tests. Netlify function integration tests are
out of scope here — exercise them via `netlify dev` and the web app.

## Netlify deploy
Config lives in `netlify.toml`. Build settings:
- Build command: `cd apps/web && npm install && npm run build`
- Publish directory: `apps/web/dist`
- Functions directory: `netlify/functions`
- Node version: `20`

Environment variables required in the Netlify dashboard:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `COMPILER_URL` (optional, for Rust compiler)
- `COMPILER_SECRET` (optional)

And, for the frontend build:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
