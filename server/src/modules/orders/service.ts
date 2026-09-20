import { prisma } from '../../db/prisma.js';
import { notFoundError } from '../../errors/AppError.js';
import { mapCustomer, type CustomerDto } from '../customers/mappers.js';
import { mapTicket, type TicketDto } from '../tickets/mappers.js';
import { mapOrder, type OrderDto } from './mappers.js';

export interface OrderDetailDto extends OrderDto {
  customer: CustomerDto;
  tickets: TicketDto[];
}

export async function getOrderDetail(orderId: string): Promise<OrderDetailDto> {
  const order = await prisma.order.findUnique({
    where: { orderId },
    include: { customer: true, tickets: { orderBy: { createdAt: 'asc' } } },
  });
  if (!order) throw notFoundError(`Order ${orderId} not found`);
  return {
    ...mapOrder(order),
    customer: mapCustomer(order.customer),
    tickets: order.tickets.map(mapTicket),
  };
}
