import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { getPrincipal } from '../../middleware/auth.js';
import { actionIdParamSchema, approveBodySchema, listActionsQuerySchema, requestActionBodySchema } from './schemas.js';
import { approveAction, executeAction, getAction, listActions, listCatalog, requestAction } from './service.js';

// Mounted under /api by app.ts (requireAuth applied).
export const router = Router();

// GET /api/tool-actions/catalog  [any role] — the registered tools (before /:actionId)
router.get(
  '/tool-actions/catalog',
  asyncHandler(async (_req, res) => {
    res.json(await listCatalog());
  }),
);

// POST /api/tool-actions  [support_agent+] — 201 on creation, 200 on an idempotent replay
router.post(
  '/tool-actions',
  asyncHandler(async (req, res) => {
    const body = requestActionBodySchema.parse(req.body);
    const { action, created } = await requestAction(body, getPrincipal(req));
    res.status(created ? 201 : 200).json(action);
  }),
);

// POST /api/tool-actions/:actionId/approve  [support_manager or admin ONLY — middleware/policy.ts]
router.post(
  '/tool-actions/:actionId/approve',
  asyncHandler(async (req, res) => {
    const { actionId } = actionIdParamSchema.parse(req.params);
    const body = approveBodySchema.parse(req.body);
    res.json(await approveAction(actionId, body, getPrincipal(req)));
  }),
);

// POST /api/tool-actions/:actionId/execute  [support_agent+]
router.post(
  '/tool-actions/:actionId/execute',
  asyncHandler(async (req, res) => {
    const { actionId } = actionIdParamSchema.parse(req.params);
    res.json(await executeAction(actionId, getPrincipal(req)));
  }),
);

// GET /api/tool-actions?ticket_id=&status=&tool_name=&limit=  [any role]
router.get(
  '/tool-actions',
  asyncHandler(async (req, res) => {
    const query = listActionsQuerySchema.parse(req.query);
    res.json(await listActions(query));
  }),
);

// GET /api/tool-actions/:actionId  [any role] — action with its approvals
router.get(
  '/tool-actions/:actionId',
  asyncHandler(async (req, res) => {
    const { actionId } = actionIdParamSchema.parse(req.params);
    res.json(await getAction(actionId));
  }),
);
