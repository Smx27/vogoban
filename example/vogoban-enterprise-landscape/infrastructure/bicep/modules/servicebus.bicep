@description('Azure region for the Service Bus namespace.')
param location string

@description('Logical namespace name, vg-enterprise-servicebus.')
param namespaceName string

@description('Topic carrying order lifecycle events, vg-order-events.')
param topicName string

@description('Subscription on the order events topic consumed by the order-processing function.')
param orderProcessorSubscriptionName string

@description('Subscription on the order events topic consumed by the notification service.')
param notificationsSubscriptionName string

@description('Queue the notification service consumes and KEDA scales on.')
param notificationRequestsQueueName string

@description('Queue the reporting platform consumes.')
param reportJobsQueueName string

@allowed([
  'Basic'
  'Standard'
  'Premium'
])
@description('Messaging tier of the namespace.')
param skuName string = 'Standard'

@description('Tags applied to every resource in this module.')
param tags object = {}

resource namespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: namespaceName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuName
  }
  properties: {
    minimumTlsVersion: '1.2'
    zoneRedundant: false
    disableLocalAuth: false
  }
}

resource orderEventsTopic 'Microsoft.ServiceBus/namespaces/topics@2022-10-01-preview' = {
  parent: namespace
  name: topicName
  properties: {
    enablePartitioning: false
    maxSizeInMegabytes: 1024
  }
}

resource orderProcessorSubscription 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2022-10-01-preview' = {
  parent: orderEventsTopic
  name: orderProcessorSubscriptionName
  properties: {
    maxDeliveryCount: 10
    deadLetteringOnMessageExpiration: true
    requiresSession: false
    defaultMessageTimeToLive: 'P14D'
  }
}

resource notificationsSubscription 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2022-10-01-preview' = {
  parent: orderEventsTopic
  name: notificationsSubscriptionName
  properties: {
    maxDeliveryCount: 10
    deadLetteringOnMessageExpiration: true
    requiresSession: false
    defaultMessageTimeToLive: 'P14D'
  }
}

resource notificationRequestsQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: namespace
  name: notificationRequestsQueueName
  properties: {
    maxDeliveryCount: 10
    deadLetteringOnMessageExpiration: true
    requiresSession: false
    defaultMessageTimeToLive: 'P7D'
  }
}

resource reportJobsQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: namespace
  name: reportJobsQueueName
  properties: {
    maxDeliveryCount: 10
    deadLetteringOnMessageExpiration: true
    requiresSession: false
    defaultMessageTimeToLive: 'P7D'
  }
}

@description('Fully qualified namespace host name, vg-enterprise-servicebus.servicebus.windows.net.')
output fullyQualifiedNamespace string = '${namespace.name}.servicebus.windows.net'

@description('Full ARM resource id of the Service Bus namespace.')
output namespaceId string = resourceId('Microsoft.ServiceBus/namespaces', namespaceName)

@description('Full ARM resource id of the vg-order-events topic.')
output topicId string = resourceId('Microsoft.ServiceBus/namespaces/topics', namespaceName, topicName)

@description('Full ARM resource id of the vg-notification-requests queue.')
output notificationRequestsQueueId string = resourceId('Microsoft.ServiceBus/namespaces/queues', namespaceName, notificationRequestsQueueName)

@description('Full ARM resource id of the vg-report-jobs queue.')
output reportJobsQueueId string = resourceId('Microsoft.ServiceBus/namespaces/queues', namespaceName, reportJobsQueueName)
