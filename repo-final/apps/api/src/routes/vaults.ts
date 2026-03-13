import { Router } from 'express';
export function buildVaultsRouter(): Router { const router = Router(); router.get('/', (_req, res) => res.json({ ok: true, vaults: [] })); return router; }
