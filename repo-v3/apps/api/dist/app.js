import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { InMemoryKeyStore } from './lib/keyService.js';
import { buildKeysRouter } from './routes/keys.js';
import { buildPoliciesRouter } from './routes/policies.js';
import { buildVaultsRouter } from './routes/vaults.js';
export function createApp() { const app = express(); const store = new InMemoryKeyStore(); app.use(cors()); app.use(express.json()); app.get('/health', (_req, res) => res.json({ ok: true, service: 'dynastytrust-api' })); app.use('/api/keys', buildKeysRouter(store)); app.use('/api/policies', buildPoliciesRouter()); app.use('/api/vaults', buildVaultsRouter()); app.use((error, _req, res, _next) => { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' }); }); return app; }
