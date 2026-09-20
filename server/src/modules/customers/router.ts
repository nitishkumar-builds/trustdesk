import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { getCustomerDetail, listCustomers } from './service.js';

const customerIdParamSchema = z.object({ customerId: z.string().min(1) });

export const router = Router();

// GET /api/customers  [any role]
router.get(
  '/customers',
  asyncHandler(async (_req, res) => {
    res.json(await listCustomers());
  }),
);

// GET /api/customers/:customerId  [any role] — customer with their orders
router.get(
  '/customers/:customerId',
  asyncHandler(async (req, res) => {
    const { customerId } = customerIdParamSchema.parse(req.params);
    res.json(await getCustomerDetail(customerId));
  }),
);
