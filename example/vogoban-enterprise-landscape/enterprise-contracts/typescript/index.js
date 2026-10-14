'use strict';

// Runtime values of the shared topology, mirroring VgEnterpriseTopology in the
// C# contract library and the resource names used by infrastructure and the
// Kubernetes manifests.

const serviceBus = {
  namespace: 'vg-enterprise-servicebus',
  fullyQualifiedNamespace: 'vg-enterprise-servicebus.servicebus.windows.net',
  orderEventsTopic: 'vg-order-events',
  orderProcessorSubscription: 'vg-order-processor',
  notificationsSubscription: 'vg-notifications',
  notificationRequestsQueue: 'vg-notification-requests',
  reportJobsQueue: 'vg-report-jobs'
};

const cosmos = {
  accountName: 'vg-enterprise-cosmos',
  database: 'vg-enterprise',
  ordersContainer: 'vg-orders',
  customersContainer: 'vg-customers',
  reportsContainer: 'vg-reports'
};

const storage = {
  accountName: 'vgentstorage',
  notificationPayloadsContainer: 'vg-notification-payloads',
  reportArtifactsContainer: 'vg-report-artifacts'
};

const deploymentUnits = {
  platformGateway: 'vg-platform-gateway',
  ordersApi: 'vg-orders-api',
  customersApi: 'vg-customers-api',
  notificationService: 'vg-notification-service',
  orderProcessorFunction: 'vg-order-processor-function',
  reportingWorker: 'vg-reporting-worker'
};

const contractIds = {
  orderCreated: 'orders/order-created',
  orderUpdated: 'orders/order-updated',
  orderCancelled: 'orders/order-cancelled',
  notificationRequested: 'notifications/notification-requested',
  reportRequested: 'reporting/report-requested'
};

module.exports = { serviceBus, cosmos, storage, deploymentUnits, contractIds };
