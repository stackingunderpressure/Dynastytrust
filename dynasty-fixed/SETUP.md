# DynastyTrust — Setup Guide

## What changed in this patch

| File | What changed |
|---|---|
| `netlify.toml` | Fixed build command, Node version, added `[functions]` block, added `/api/*` redirect |
| `netlify/functions/package.json` | Added all missing dependencies (`@supabase/supabase-js`, `jose`, `pdf-lib`, `qrcode`) |
| `db/migrations/002_vaults.sql` | New migration: `vaults`, `vault_events`, `proposals`, `signer_sessions` tables with RLS |
| `apps/web/package.json` | Added `@supabase/supabase-js` |
| `apps/web/src/lib/supabase.ts` | Supabase client singleton |
| `apps/web/src/lib/api.ts` | Unified API client — calls Netlify functions with JWT auth |
| `apps/web/src/pages/Auth.tsx` | Login / signup page |
| `apps/web/src/pages/Dashboard.tsx` | Vault list with live balances |
| `apps/web/src/pages/VaultDetail.tsx` | Vault detail, proposals, keys, spend modal |
| `apps/web/src/App.tsx` | Auth state + simple client-side routing |
| `apps/web/src/main.tsx` | Entry point with global reset |
| `apps/web/index.html` | Added Google Fonts |
| `apps/web/.env.example` | Updated env var names |

---

## Step 1 — Copy these files into your repo

Replace the corresponding files in your `Dynastytrust-main` folder with the files from this patch.

---

## Step 2 — Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Give it a name (e.g. `dynastytrust`), pick a region, set a database password
3. Wait ~2 minutes for provisioning

Once ready, go to **Settings → API** and copy:
- **Project URL** — looks like `https://abcdefgh.supabase.co`
- **anon / public key** — starts with `eyJ`
- **service_role key** (secret!) — also starts with `eyJ`

---

## Step 3 — Run the database migrations

In Supabase dashboard → **SQL Editor** → **New query**:

1. Paste and run `db/migrations/001_init.sql`
2. Paste and run `db/migrations/002_vaults.sql`

Both should complete with no errors.

---

## Step 4 — Set environment variables in Netlify

In **Netlify dashboard → Site → Environment variables**, add these:

### Backend (used by Netlify Functions — keep secret)
| Key | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase service_role key |
| `COMPILER_URL` | Leave blank for now (functions gracefully degrade) |
| `COMPILER_SECRET` | Leave blank for now |

### Frontend (used by Vite build — these get embedded in the JS bundle)
| Key | Value |
|---|---|
| `VITE_SUPABASE_URL` | Your Supabase Project URL (same as above) |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase anon key |

---

## Step 5 — Set Supabase auth settings

In Supabase dashboard → **Authentication → URL Configuration**:

- **Site URL**: `https://YOUR-SITE.netlify.app`
- **Redirect URLs**: add `https://YOUR-SITE.netlify.app`

This is required for email confirmation links to work.

---

## Step 6 — Push to GitHub and trigger a deploy

```bash
git add -A
git commit -m "fix: netlify build, functions deps, supabase wiring"
git push
```

Netlify will auto-deploy. The build should now succeed.

---

## Step 7 — Verify everything works

1. Open your Netlify URL
2. Create an account → check email for confirmation
3. Sign in → Dashboard loads
4. Create a vault (you'll need to paste in a compiled vault — see below)

---

## Creating your first vault

The frontend's "New Vault" form expects a pre-compiled vault (address + descriptor + miniscript policy). You have two ways to get one:

**Option A — Use the Rust compiler (full flow)**
Deploy the compiler to Fly.io (see `compiler/fly.toml`), set `COMPILER_URL` in Netlify, then use the `/api/compile` endpoint.

**Option B — Use a testnet tool for now**
Use [miniscript.fun](https://miniscript.fun) or the `bitcoin-cli` to generate a descriptor and testnet address manually, then paste it into the form.

---

## Local development

```bash
npm install                          # install all workspace deps
cp apps/web/.env.example apps/web/.env
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY

npm install -g netlify-cli           # install Netlify CLI once
netlify dev                          # runs frontend + functions locally
```

`netlify dev` handles the `/api/*` → function routing locally, matching production exactly.
