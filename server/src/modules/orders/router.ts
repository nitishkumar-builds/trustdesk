import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { getOrderDetail } from './service.js';

const orderIdParamSchema = z.object({ orderId: z.string().min(1) });

export const router = Router();

// GET /api/orders/:orderId  [any role] — order with customer and matching tickets
router.get(
  '/orders/:orderId',
  asyncHandler(async (req, res) => {
    const { orderId } = orderIdParamSchema.parse(req.params);
    res.json(await getOrderDetail(orderId));
  }),
);
