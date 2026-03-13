import { Router } from 'express';
import { summarizePolicy, validatePolicy, type VaultPolicy } from '@dynastytrust/policy-engine';
export function buildPoliciesRouter(): Router { const router = Router(); router.post('/validate', (req, res) => { const policy = req.body as VaultPolicy; const result = validatePolicy(policy); res.json({ ...result, summary: summarizePolicy(policy) }); }); return router; }
