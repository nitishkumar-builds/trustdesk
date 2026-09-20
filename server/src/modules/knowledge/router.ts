import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { docIdParamSchema, ingestBodySchema, searchQuerySchema } from './schemas.js';
import { searchKnowledge } from './search.js';
import { getDocument, ingestDocuments, listDocuments, reingestFromDisk } from './service.js';

// Mounted under /api by app.ts (requireAuth already applied).
export const router = Router();

// POST /api/documents/ingest  [admin — middleware/policy.ts]
router.post(
  '/documents/ingest',
  asyncHandler(async (req, res) => {
    const { documents } = ingestBodySchema.parse(req.body);
    res.json(await ingestDocuments(documents));
  }),
);

// POST /api/documents/reingest  [admin — middleware/policy.ts] — re-runs the loader over data/knowledge_base/
router.post(
  '/documents/reingest',
  asyncHandler(async (_req, res) => {
    res.json(await reingestFromDisk());
  }),
);

// GET /api/documents/search?q=&category=&limit=  [any role]  (before /documents/:docId)
router.get(
  '/documents/search',
  asyncHandler(async (req, res) => {
    const { q, category, limit, mode } = searchQuerySchema.parse(req.query);
    const { results, mode: usedMode } = await searchKnowledge({ query: q, categoryHint: category, limit, mode });
    res.json({ query: q, mode: usedMode, results });
  }),
);

// GET /api/documents  [any role]
router.get(
  '/documents',
  asyncHandler(async (_req, res) => {
    res.json(await listDocuments());
  }),
);

// GET /api/documents/:docId  [any role]
router.get(
  '/documents/:docId',
  asyncHandler(async (req, res) => {
    const { docId } = docIdParamSchema.parse(req.params);
    res.json(await getDocument(docId));
  }),
);
