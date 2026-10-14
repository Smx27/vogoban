// Type declarations for @vg/enterprise-contracts. These mirror the C# records in
// dotnet/Enterprise.Contracts and the JSON Schemas under contracts/, using the
// camelCase property names the API serializer emits.

export interface OrderLineDto {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderDto {
  id: string;
  customerId: string;
  lines: OrderLineDto[];
  total: number;
  status: string;
  createdAt: string;
}

export interface CreateOrderRequest {
  customerId: string;
  lines: OrderLineDto[];
}

export interface CustomerDto {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface CreateCustomerRequest {
  name: string;
  email: string;
}

export interface NotificationPreferenceDto {
  customerId: string;
  channel: string;
  address: string;
  enabled: boolean;
}

export interface CustomerOrderSummaryDto {
  customerId: string;
  orderCount: number;
  totalValue: number;
}

export interface NotificationDispatchDto {
  id: string;
  customerId: string;
  channel: string;
  recipient: string;
  status: string;
  createdAt: string;
}

export interface ReportDto {
  id: string;
  reportType: string;
  status: string;
  artifactPath: string;
  requestedAt: string;
}

export interface CreateReportRequest {
  reportType: string;
  requestedBy: string;
}

export interface OrderCreatedEvent {
  orderId: string;
  customerId: string;
  total: number;
  createdAt: string;
}

export interface OrderUpdatedEvent {
  orderId: string;
  customerId: string;
  total: number;
  status: string;
  updatedAt: string;
}

export interface OrderCancelledEvent {
  orderId: string;
  customerId: string;
  reason: string;
  cancelledAt: string;
}

export interface NotificationRequestedEvent {
  notificationId: string;
  customerId: string;
  recipient: string;
  subject: string;
  body: string;
  channel: string;
  requestedAt: string;
}

export interface ReportRequestedEvent {
  reportId: string;
  reportType: string;
  requestedBy: string;
  requestedAt: string;
}

export declare const serviceBus: {
  namespace: string;
  fullyQualifiedNamespace: string;
  orderEventsTopic: string;
  orderProcessorSubscription: string;
  notificationsSubscription: string;
  notificationRequestsQueue: string;
  reportJobsQueue: string;
};

export declare const cosmos: {
  accountName: string;
  database: string;
  ordersContainer: string;
  customersContainer: string;
  reportsContainer: string;
};

export declare const storage: {
  accountName: string;
  notificationPayloadsContainer: string;
  reportArtifactsContainer: string;
};

export declare const deploymentUnits: {
  platformGateway: string;
  ordersApi: string;
  customersApi: string;
  notificationService: string;
  orderProcessorFunction: string;
  reportingWorker: string;
};

export declare const contractIds: {
  orderCreated: string;
  orderUpdated: string;
  orderCancelled: string;
  notificationRequested: string;
  reportRequested: string;
};
