# Dynastytrust Phase 1 Deploy Notes

## What is included
- `apps/web` - Vite React frontend
- `apps/api` - Express API
- `packages/policy-engine` - shared policy validation package
- `db/migrations` - next-step database wiring

## Important
This package intentionally does **not** include `node_modules/`.
Install dependencies fresh after upload:

```bash
npm install
```

## Local test
```bash
npm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
# put a real APP_MASTER_KEY into apps/api/.env
npm test
npm run build
```

## Netlify web deploy
Repository root should contain the `dynastytrust-phase1` folder from this zip.
Use:
- Base directory: `dynastytrust-phase1`
- Build command: `npm install && npm run build --workspace @dynastytrust/web`
- Publish directory: `apps/web/dist`
- Node version: `20`

Set web environment variable only if you are not using a redirect:
- `VITE_API_BASE=https://your-api-host/api`

If you want the frontend to call the API through the same Netlify domain,
edit `netlify.toml` and replace `https://YOUR-API-HOST` with your deployed API host.

## API deploy
The API needs:
- `APP_MASTER_KEY` as a 64-character hex string
- `PORT` is optional and defaults to `8080`

Build and run:
```bash
npm install
npm run build --workspace @dynastytrust/api
node apps/api/dist/server.js
```
