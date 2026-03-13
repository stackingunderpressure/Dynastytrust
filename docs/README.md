# Dynastytrust Phase 1

Tested starter package for:

- software key generation
- encrypted private-key blobs at rest
- Keyring first-load page
- policy validation endpoint

## Local run

```bash
npm install
export APP_MASTER_KEY=$(openssl rand -hex 32)
npm test
cd apps/api && npm run dev
cd apps/web && npm run dev
```

This package uses an in-memory store for immediate local testing. The SQL migration is included for the next Postgres wiring step.
