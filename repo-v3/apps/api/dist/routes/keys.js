import { Router } from 'express';
import { z } from 'zod';
import { createSoftwareKey } from '../lib/keyService.js';
const generateSchema = z.object({ label: z.string().min(1).max(80), network: z.enum(['testnet', 'mainnet']).default('testnet') });
function userId(req) { return req.header('x-user-id') ?? 'demo-user'; }
export function buildKeysRouter(store) {
    const router = Router();
    router.get('/', async (req, res) => { const keys = await store.listKeys(userId(req)); res.json({ ok: true, keys: keys.map(({ encryptedPrivateBlob, ...rest }) => rest) }); });
    router.post('/generate', async (req, res, next) => { try {
        const parsed = generateSchema.parse(req.body);
        const key = await createSoftwareKey(store, { userId: userId(req), label: parsed.label, network: parsed.network });
        const { encryptedPrivateBlob, ...rest } = key;
        res.status(201).json({ ok: true, key: rest });
    }
    catch (error) {
        next(error);
    } });
    router.post('/:id/archive', async (req, res) => { const key = await store.updateStatus(userId(req), req.params.id, 'archived'); if (!key)
        return void res.status(404).json({ ok: false, error: 'Key not found' }); const { encryptedPrivateBlob, ...rest } = key; res.json({ ok: true, key: rest }); });
    router.post('/:id/compromise', async (req, res) => { const key = await store.updateStatus(userId(req), req.params.id, 'compromised'); if (!key)
        return void res.status(404).json({ ok: false, error: 'Key not found' }); const { encryptedPrivateBlob, ...rest } = key; res.json({ ok: true, key: rest }); });
    return router;
}
