import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  returnWindowStatus,
  warrantyStatus,
  type PolicyCustomer,
  type PolicyOrder,
  type PolicyOrderItem,
} from '../src/domain/policyWindows.js';

// Cases are derived from the read-only pack in data/ (rule R1: asOf is always a ticket created_at).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface RawOrder {
  order_id: string;
  customer_id: string;
  delivered_at: string | null;
  eligible_return_until: string | null;
  total: number;
  items: PolicyOrderItem[];
}
interface RawCustomer {
  customer_id: string;
  tier: string;
}

const rawOrders = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'data/orders.json'), 'utf8'),
) as RawOrder[];
const rawCustomers = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'data/customers.json'), 'utf8'),
) as RawCustomer[];

const utcDate = (s: string | null): Date | null => (s ? new Date(`${s}T00:00:00.000Z`) : null);

function order(id: string): PolicyOrder {
  const o = rawOrders.find((r) => r.order_id === id);
  if (!o) throw new Error(`no order ${id} in seed data`);
  return {
    orderId: o.order_id,
    deliveredAt: utcDate(o.delivered_at),
    eligibleReturnUntil: utcDate(o.eligible_return_until),
    total: o.total,
    items: o.items,
  };
}

function customerOf(orderId: string): PolicyCustomer {
  const o = rawOrders.find((r) => r.order_id === orderId)!;
  const c = rawCustomers.find((r) => r.customer_id === o.customer_id);
  if (!c) throw new Error(`no customer for ${orderId}`);
  return { tier: c.tier };
}

describe('returnWindowStatus', () => {
  const cases: Array<{
    name: string;
    orderId: string;
    asOf: string; // ticket created_at
    eligible: boolean;
    reason: string;
  }> = [
    {
      name: 'ord_5001 (tkt_9001) inside the 7-day window',
      orderId: 'ord_5001',
      asOf: '2026-06-28T10:15:00+05:30',
      eligible: true,
      reason: 'within_return_window',
    },
    {
      name: 'ord_5001 on the last calendar day of the window is still eligible',
      orderId: 'ord_5001',
      asOf: '2026-07-01T23:00:00+05:30',
      eligible: true,
      reason: 'within_return_window',
    },
    {
      name: 'ord_5001 the day after the window has expired',
      orderId: 'ord_5001',
      asOf: '2026-07-03T09:00:00+05:30',
      eligible: false,
      reason: 'window_expired',
    },
    {
      name: 'ord_5004 (tkt_9003) is final sale so never eligible, even inside the window',
      orderId: 'ord_5004',
      asOf: '2026-05-23T09:05:00+05:30',
      eligible: false,
      reason: 'final_sale',
    },
    {
      name: 'ord_5004 (tkt_9003) at the real ticket date is still final_sale',
      orderId: 'ord_5004',
      asOf: '2026-06-01T09:05:00+05:30',
      eligible: false,
      reason: 'final_sale',
    },
    {
      name: 'ord_5002 (tkt_9002) has not been delivered',
      orderId: 'ord_5002',
      asOf: '2026-07-02T12:20:00+05:30',
      eligible: false,
      reason: 'not_delivered',
    },
    {
      name: 'ord_5003 (tkt_9005) window ended 2026-06-21',
      orderId: 'ord_5003',
      asOf: '2026-07-02T17:45:00+05:30',
      eligible: false,
      reason: 'window_expired',
    },
    {
      name: 'ord_5006 (tkt_9008) inside window on 2026-07-02',
      orderId: 'ord_5006',
      asOf: '2026-07-02T20:00:00+05:30',
      eligible: true,
      reason: 'within_return_window',
    },
    {
      name: 'ord_5005 (tkt_9004) return window long expired',
      orderId: 'ord_5005',
      asOf: '2026-07-01T15:30:00+05:30',
      eligible: false,
      reason: 'window_expired',
    },
  ];

  it.each(cases)('$name', ({ orderId, asOf, eligible, reason }) => {
    const result = returnWindowStatus({ order: order(orderId), asOf: new Date(asOf) });
    expect(result.eligible).toBe(eligible);
    expect(result.reason).toBe(reason);
  });

  it('uses eligible_return_until when present', () => {
    const result = returnWindowStatus({ order: order('ord_5001'), asOf: new Date('2026-06-28T00:00:00Z') });
    expect(result.windowEndsAt?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('falls back to delivered_at + 7 days when eligible_return_until is missing', () => {
    const o = { ...order('ord_5001'), eligibleReturnUntil: null };
    const result = returnWindowStatus({ order: o, asOf: new Date('2026-06-28T00:00:00Z') });
    expect(result.windowEndsAt?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('flags software as non_returnable_category when not final sale', () => {
    const o = order('ord_5004');
    o.items = o.items.map((i) => ({ ...i, final_sale: false }));
    const result = returnWindowStatus({ order: o, asOf: new Date('2026-05-23T00:00:00Z') });
    expect(result).toMatchObject({ eligible: false, reason: 'non_returnable_category' });
  });

  it('never consults the wall clock: the same asOf gives the same answer regardless of today', () => {
    const a = returnWindowStatus({ order: order('ord_5001'), asOf: new Date('2026-06-28T00:00:00Z') });
    const b = returnWindowStatus({ order: order('ord_5001'), asOf: new Date('2026-06-28T00:00:00Z') });
    expect(a).toEqual(b);
    expect(a.eligible).toBe(true);
  });
});

describe('warrantyStatus', () => {
  it('ord_5005 (tkt_9004): ~12.9 months from delivery, gold customer, inside the extended window', () => {
    const result = warrantyStatus({
      order: order('ord_5005'),
      customer: customerOf('ord_5005'),
      asOf: new Date('2026-07-01T15:30:00+05:30'),
    });
    expect(result.monthsSinceDelivery).toBeGreaterThan(12.8);
    expect(result.monthsSinceDelivery).toBeLessThan(13);
    expect(result).toMatchObject({
      covered: true,
      windowMonths: 18,
      extensionApplied: true,
      reason: 'within_gold_extension',
    });
  });

  it('ord_5005 with a standard-tier customer is out of warranty at the same asOf', () => {
    const result = warrantyStatus({
      order: order('ord_5005'),
      customer: { tier: 'standard' },
      asOf: new Date('2026-07-01T15:30:00+05:30'),
    });
    expect(result).toMatchObject({
      covered: false,
      windowMonths: 12,
      extensionApplied: false,
      reason: 'warranty_expired',
    });
  });

  it('ord_5001 (tkt_9001): gold customer, 4 days after delivery, within standard warranty', () => {
    const result = warrantyStatus({
      order: order('ord_5001'),
      customer: customerOf('ord_5001'),
      asOf: new Date('2026-06-28T10:15:00+05:30'),
    });
    expect(result).toMatchObject({
      covered: true,
      windowMonths: 18,
      extensionApplied: true,
      reason: 'within_standard_warranty',
    });
    expect(result.monthsSinceDelivery).toBeCloseTo(0.14, 1);
  });

  it('ord_5004 (tkt_9003): software + final sale gets no gold extension even for a gold customer', () => {
    const result = warrantyStatus({
      order: order('ord_5004'),
      customer: { tier: 'gold' },
      asOf: new Date('2026-06-01T09:05:00+05:30'),
    });
    expect(result.extensionApplied).toBe(false);
    expect(result.windowMonths).toBe(12);
    expect(result.covered).toBe(true);
  });

  it('accessory under INR 3000 gets no gold extension', () => {
    const o = order('ord_5002');
    o.deliveredAt = new Date('2026-06-25T00:00:00Z');
    const result = warrantyStatus({
      order: o,
      customer: { tier: 'gold' },
      asOf: new Date('2026-07-02T12:20:00+05:30'),
    });
    expect(result.extensionApplied).toBe(false);
    expect(result.windowMonths).toBe(12);
  });

  it('ord_5002 (tkt_9002): not delivered yet, so not covered', () => {
    const result = warrantyStatus({
      order: order('ord_5002'),
      customer: customerOf('ord_5002'),
      asOf: new Date('2026-07-02T12:20:00+05:30'),
    });
    expect(result).toMatchObject({ covered: false, monthsSinceDelivery: null, reason: 'not_delivered' });
  });

  it('standard warranty ends exactly 12 calendar months after delivery', () => {
    const o = order('ord_5006'); // delivered 2026-06-30
    const customer = { tier: 'standard' };
    const lastDay = warrantyStatus({ order: o, customer, asOf: new Date('2027-06-30T00:00:00Z') });
    const dayAfter = warrantyStatus({ order: o, customer, asOf: new Date('2027-07-01T00:00:00Z') });
    expect(lastDay.covered).toBe(true);
    expect(dayAfter.covered).toBe(false);
  });
});
