import type { Customer } from '@prisma/client';

export interface CustomerSummaryDto {
  customer_id: string;
  name: string;
  tier: string;
}

export interface CustomerDto extends CustomerSummaryDto {
  email: string;
  country: string;
  created_at: string;
  verified: boolean;
  tags: string[];
}

export function mapCustomerSummary(c: Customer): CustomerSummaryDto {
  return { customer_id: c.customerId, name: c.name, tier: c.tier };
}

export function mapCustomer(c: Customer): CustomerDto {
  return {
    customer_id: c.customerId,
    name: c.name,
    email: c.email,
    tier: c.tier,
    country: c.country,
    created_at: c.createdAt.toISOString(),
    verified: c.verified,
    tags: c.tags,
  };
}
