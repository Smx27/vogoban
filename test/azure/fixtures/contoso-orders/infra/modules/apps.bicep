param prefix string
param location string
param tags object
param identityId string
param identityClientId string
param serviceBusNamespace string
param eventHubsNamespace string
param cosmosEndpoint string
param eventGridEndpoint string
param appInsightsConnectionString string
param keyVaultName string

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'plan-${prefix}'
  location: location
  sku: { name: 'P1v3' }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stcontosoorders'
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: true
    minimumTlsVersion: 'TLS1_2'
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: 'func-${prefix}'
  location: location
  kind: 'functionapp,linux'
  tags: union(tags, { 'azd-service-name': 'functions' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'dotnet-isolated' }
        { name: 'ServiceBus__fullyQualifiedNamespace', value: '${serviceBusNamespace}.servicebus.windows.net' }
        { name: 'ServiceBus__clientId', value: identityClientId }
        { name: 'ServiceBus__credential', value: 'managedidentity' }
        { name: 'EventHubs__fullyQualifiedNamespace', value: '${eventHubsNamespace}.servicebus.windows.net' }
        { name: 'Cosmos__accountEndpoint', value: cosmosEndpoint }
        { name: 'CleanupSchedule', value: '0 0 3 * * *' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
        { name: 'StorageConnection', value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value}' }
      ]
    }
  }
}

resource api 'Microsoft.Web/sites@2023-12-01' = {
  name: 'app-${prefix}-api'
  location: location
  kind: 'app,linux'
  tags: union(tags, { 'azd-service-name': 'api' })
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      appSettings: [
        { name: 'ConnectionStrings__messaging', value: 'Endpoint=sb://${serviceBusNamespace}.servicebus.windows.net/' }
        { name: 'EventGrid__Endpoint', value: eventGridEndpoint }
        { name: 'ApiKey', value: '@Microsoft.KeyVault(SecretUri=https://${keyVaultName}.vault.azure.net/secrets/api-key)' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
      ]
    }
  }
}

resource web 'Microsoft.Web/staticSites@2023-12-01' = {
  name: 'stapp-${prefix}'
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  sku: { name: 'Standard' }
  properties: {}
}

output functionAppId string = functionApp.id
output apiHostName string = api.properties.defaultHostName
