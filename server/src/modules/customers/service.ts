import { prisma } from '../../db/prisma.js';
import { notFoundError } from '../../errors/AppError.js';
import { mapOrder, type OrderDto } from '../orders/mappers.js';
import { mapCustomer, type CustomerDto } from './mappers.js';

export interface CustomerListResult {
  items: Array<CustomerDto & { order_count: number; ticket_count: number }>;
  total: number;
}

export interface CustomerDetailDto extends CustomerDto {
  orders: OrderDto[];
}

export async function listCustomers(): Promise<CustomerListResult> {
  const rows = await prisma.customer.findMany({
    include: { _count: { select: { orders: true, tickets: true } } },
    orderBy: { customerId: 'asc' },
  });
  return {
    items: rows.map((c) => ({
      ...mapCustomer(c),
      order_count: c._count.orders,
      ticket_count: c._count.tickets,
    })),
    total: rows.length,
  };
}

export async function getCustomerDetail(customerId: string): Promise<CustomerDetailDto> {
  const customer = await prisma.customer.findUnique({
    where: { customerId },
    include: { orders: { orderBy: { placedAt: 'desc' } } },
  });
  if (!customer) throw notFoundError(`Customer ${customerId} not found`);
  return { ...mapCustomer(customer), orders: customer.orders.map(mapOrder) };
}
