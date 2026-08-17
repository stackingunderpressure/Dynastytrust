# Dynastytrust

Bitcoin multisig inheritance vaults with founder/heir key policies,
timelocked recovery paths, PSBT signing, and Supabase-backed governance.

## Local run

```bash
npm install
cp apps/web/.env.example apps/web/.env
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY

npm install -g netlify-cli
netlify dev
```

`netlify dev` serves the React frontend and the functions in
`netlify/functions/` together on one port.

## Tests

```bash
npm test
```

## Deployment

- Web + functions: Netlify (see `DEPLOY-README.md`)
- Policy compiler: Fly.io (see `compiler/fly.toml`)
- Database: Supabase (migrations in `supabase/migrations/`, applied
  automatically on push to main -- see
  `.github/workflows/supabase-db-deploy.yml`)
