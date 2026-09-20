import type { Order } from '@prisma/client';

export interface OrderDto {
  order_id: string;
  customer_id: string;
  status: string;
  placed_at: string;
  delivered_at: string | null;
  eligible_return_until: string | null;
  total: number;
  currency: string;
  payment_status: string;
  tracking_number: string;
  items: unknown[];
}

export function mapOrder(o: Order): OrderDto {
  return {
    order_id: o.orderId,
    customer_id: o.customerId,
    status: o.status,
    placed_at: o.placedAt.toISOString(),
    delivered_at: o.deliveredAt?.toISOString() ?? null,
    eligible_return_until: o.eligibleReturnUntil?.toISOString() ?? null,
    total: o.total,
    currency: o.currency,
    payment_status: o.paymentStatus,
    tracking_number: o.trackingNumber,
    items: Array.isArray(o.items) ? (o.items as unknown[]) : [],
  };
}
