import 'server-only';

import type {
  CustomerDto,
  CustomerOrderSummaryDto,
  OrderDto,
} from '@vg/enterprise-contracts';

const gatewayBaseUrl = process.env.GATEWAY_BASE_URL ?? 'http://localhost:5180';

async function getFromGateway<TResponse>(path: string): Promise<TResponse> {
  const response = await fetch(`${gatewayBaseUrl}${path}`, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`Gateway GET ${path} failed with ${response.status}.`);
  }

  return (await response.json()) as TResponse;
}

export function listOrders(): Promise<OrderDto[]> {
  return getFromGateway<OrderDto[]>('/api/Orders');
}

export function getOrder(id: string): Promise<OrderDto> {
  return getFromGateway<OrderDto>(`/api/Orders/${id}`);
}

export function listCustomers(): Promise<CustomerDto[]> {
  return getFromGateway<CustomerDto[]>('/api/Customers');
}

export function getCustomer(id: string): Promise<CustomerDto> {
  return getFromGateway<CustomerDto>(`/api/Customers/${id}`);
}

export function getCustomerOrders(id: string): Promise<CustomerOrderSummaryDto> {
  return getFromGateway<CustomerOrderSummaryDto>(`/api/Customers/${id}/orders`);
}
