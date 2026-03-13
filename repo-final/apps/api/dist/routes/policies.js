import { Router } from 'express';
import { summarizePolicy, validatePolicy } from '@dynastytrust/policy-engine';
export function buildPoliciesRouter() { const router = Router(); router.post('/validate', (req, res) => { const policy = req.body; const result = validatePolicy(policy); res.json({ ...result, summary: summarizePolicy(policy) }); }); return router; }
