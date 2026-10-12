param location string = 'westeurope'

resource alpha 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: 'sb-alpha'
  location: location
  resource orders 'queues' = { name: 'orders' }
}

resource beta 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: 'sb-beta'
  location: location
  resource orders 'queues' = { name: 'orders' }
}

resource unnamedOne 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  name: ''
}

resource unnamedTwo 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  name: '   '
}

resource worker 'Microsoft.Web/sites@2023-12-01' = {
  name: 'func-worker'
  location: location
  kind: 'functionapp'
  tags: { 'azd-service-name': 'worker' }
  properties: {
    siteConfig: {
      appSettings: [
        { name: 'ServiceBusConnection__fullyQualifiedNamespace', value: '${beta.name}.servicebus.windows.net' }
      ]
    }
  }
}
