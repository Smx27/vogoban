param namespaceName string
param eventHubsNamespaceName string
param location string

resource sb 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: namespaceName
  location: location
  sku: { name: 'Standard' }
  properties: {
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    minimumTlsVersion: '1.2'
  }

  resource orders 'topics' = {
    name: 'orders'

    resource billing 'subscriptions' = {
      name: 'billing'
      properties: {
        maxDeliveryCount: 10
      }
    }
  }
}

resource evhns 'Microsoft.EventHub/namespaces@2024-01-01' = {
  name: eventHubsNamespaceName
  location: location
  sku: { name: 'Standard' }
}

resource telemetry 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  parent: evhns
  name: 'order-telemetry'
  properties: {
    partitionCount: 4
  }
}

output namespaceName string = sb.name
output eventHubsNamespaceName string = evhns.name
