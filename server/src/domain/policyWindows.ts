/**
 * Policy window evaluation — pure functions, no database access.
 *
 * RULE R1: policy windows (return eligibility, warranty) are ALWAYS evaluated against the
 * ticket's created_at, which callers pass as `asOf`. Nothing in this file may call Date.now()
 * or `new Date()` without an argument. The seed data is static; the wall clock would make
 * every case expire over time.
 *
 * Policy sources: KB-REFUND-001 (7-day return window, non-returnable categories) and
 * KB-WARRANTY-001 (12-month warranty, gold-tier 6-month extension and its exclusions).
 */

export interface PolicyOrderItem {
  sku: string;
  name: string;
  quantity: number;
  category: string;
  final_sale: boolean;
  /** Optional per-unit price; when absent the order total is apportioned by quantity. */
  unit_price?: number;
}

export interface PolicyOrder {
  orderId: string;
  deliveredAt: Date | null;
  eligibleReturnUntil: Date | null;
  total: number;
  items: PolicyOrderItem[];
}

export interface PolicyCustomer {
  tier: string;
}

export type ReturnWindowReason =
  | 'within_return_window'
  | 'window_expired'
  | 'final_sale'
  | 'non_returnable_category'
  | 'not_delivered';

export interface ReturnWindowStatus {
  eligible: boolean;
  reason: ReturnWindowReason;
  windowEndsAt: Date | null;
}

export type WarrantyReason =
  | 'within_standard_warranty'
  | 'within_gold_extension'
  | 'warranty_expired'
  | 'not_delivered';

export interface WarrantyStatus {
  covered: boolean;
  monthsSinceDelivery: number | null;
  windowMonths: number;
  extensionApplied: boolean;
  reason: WarrantyReason;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RETURN_WINDOW_DAYS = 7;
const BASE_WARRANTY_MONTHS = 12;
const GOLD_EXTENSION_MONTHS = 6;
const ACCESSORY_EXTENSION_MIN_PRICE_INR = 3000;
const NON_RETURNABLE_CATEGORIES: ReadonlySet<string> = new Set(['software']);
const AVERAGE_DAYS_PER_MONTH = 365.25 / 12;

export function returnWindowStatus(input: { order: PolicyOrder; asOf: Date }): ReturnWindowStatus {
  const { order, asOf } = input;
  const windowEndsAt = computeReturnWindowEnd(order);

  if (order.items.some((item) => item.final_sale)) {
    return { eligible: false, reason: 'final_sale', windowEndsAt };
  }
  if (order.items.some((item) => NON_RETURNABLE_CATEGORIES.has(item.category))) {
    return { eligible: false, reason: 'non_returnable_category', windowEndsAt };
  }
  if (windowEndsAt === null) {
    return { eligible: false, reason: 'not_delivered', windowEndsAt };
  }
  // The window end is a calendar date; the whole of that day counts as inside the window.
  const inside = asOf.getTime() < windowEndsAt.getTime() + DAY_MS;
  return {
    eligible: inside,
    reason: inside ? 'within_return_window' : 'window_expired',
    windowEndsAt,
  };
}

function computeReturnWindowEnd(order: PolicyOrder): Date | null {
  if (order.eligibleReturnUntil) return new Date(order.eligibleReturnUntil.getTime());
  if (order.deliveredAt) return new Date(order.deliveredAt.getTime() + RETURN_WINDOW_DAYS * DAY_MS);
  return null;
}

export function warrantyStatus(input: {
  order: PolicyOrder;
  customer: PolicyCustomer;
  asOf: Date;
}): WarrantyStatus {
  const { order, customer, asOf } = input;

  if (!order.deliveredAt) {
    return {
      covered: false,
      monthsSinceDelivery: null,
      windowMonths: BASE_WARRANTY_MONTHS,
      extensionApplied: false,
      reason: 'not_delivered',
    };
  }

  const extensionApplied =
    customer.tier === 'gold' && order.items.every((item) => isExtensionEligible(item, order));
  const windowMonths = BASE_WARRANTY_MONTHS + (extensionApplied ? GOLD_EXTENSION_MONTHS : 0);

  const monthsSinceDelivery = round2(
    (asOf.getTime() - order.deliveredAt.getTime()) / DAY_MS / AVERAGE_DAYS_PER_MONTH,
  );
  const standardEnd = addMonthsUtc(order.deliveredAt, BASE_WARRANTY_MONTHS);
  const windowEnd = addMonthsUtc(order.deliveredAt, windowMonths);

  if (asOf.getTime() <= standardEnd.getTime()) {
    return {
      covered: true,
      monthsSinceDelivery,
      windowMonths,
      extensionApplied,
      reason: 'within_standard_warranty',
    };
  }
  if (extensionApplied && asOf.getTime() <= windowEnd.getTime()) {
    return {
      covered: true,
      monthsSinceDelivery,
      windowMonths,
      extensionApplied,
      reason: 'within_gold_extension',
    };
  }
  return {
    covered: false,
    monthsSinceDelivery,
    windowMonths,
    extensionApplied,
    reason: 'warranty_expired',
  };
}

// KB-WARRANTY-001: the gold extension does not apply to software licenses, final-sale items,
// or accessories under INR 3000.
function isExtensionEligible(item: PolicyOrderItem, order: PolicyOrder): boolean {
  if (item.final_sale) return false;
  if (item.category === 'software') return false;
  if (item.category === 'accessory' && unitPrice(item, order) < ACCESSORY_EXTENSION_MIN_PRICE_INR) {
    return false;
  }
  return true;
}

function unitPrice(item: PolicyOrderItem, order: PolicyOrder): number {
  if (typeof item.unit_price === 'number') return item.unit_price;
  const totalQuantity = order.items.reduce((sum, i) => sum + Math.max(1, i.quantity), 0);
  return order.total / Math.max(1, totalQuantity);
}

function addMonthsUtc(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Normalises a Prisma `Order` row (items stored as Json) into the shape these functions take. */
export function toPolicyOrder(order: {
  orderId: string;
  deliveredAt: Date | null;
  eligibleReturnUntil: Date | null;
  total: number;
  items: unknown;
}): PolicyOrder {
  const items = Array.isArray(order.items) ? (order.items as PolicyOrderItem[]) : [];
  return {
    orderId: order.orderId,
    deliveredAt: order.deliveredAt,
    eligibleReturnUntil: order.eligibleReturnUntil,
    total: order.total,
    items,
  };
}
