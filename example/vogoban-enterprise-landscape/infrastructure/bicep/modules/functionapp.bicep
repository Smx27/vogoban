@description('Azure region for the plan and the function app.')
param location string

@description('App Service plan name, vg-enterprise-plan.')
param planName string

@description('Linux function app name, vg-order-processor-function.')
param functionAppName string

@allowed([
  'Y1'
  'EP1'
  'EP2'
  'EP3'
])
@description('App Service plan SKU. Y1 is the consumption plan.')
param planSkuName string = 'Y1'

@description('Resource id of the user-assigned managed identity the app runs as.')
param identityId string

@description('Client id of that identity, exported as AZURE_CLIENT_ID.')
param identityClientId string

@description('Vault URI that every Key Vault reference in appSettings is built from.')
param keyVaultUri string

@description('Secret holding the Service Bus connection string.')
param serviceBusConnectionSecretName string

@description('Secret holding the Cosmos DB connection string.')
param cosmosConnectionSecretName string

@description('Secret holding the storage connection string.')
param storageConnectionSecretName string

@description('Fully qualified Service Bus namespace, vg-enterprise-servicebus.servicebus.windows.net.')
param serviceBusFullyQualifiedNamespace string

@description('Cosmos DB account endpoint, https://vg-enterprise-cosmos.documents.azure.com:443/.')
param cosmosAccountEndpoint string

@description('Blob service URI, https://vgentstorage.blob.core.windows.net/.')
param storageBlobServiceUri string

@description('Application Insights connection string.')
param appInsightsConnectionString string

@description('Tags applied to every resource in this module.')
param tags object = {}

var planTier = planSkuName == 'Y1' ? 'Dynamic' : 'ElasticPremium'

var keyVaultServiceBusReference = '@Microsoft.KeyVault(SecretUri=${keyVaultUri}secrets/${serviceBusConnectionSecretName}/)'
var keyVaultCosmosReference = '@Microsoft.KeyVault(SecretUri=${keyVaultUri}secrets/${cosmosConnectionSecretName}/)'
var keyVaultStorageReference = '@Microsoft.KeyVault(SecretUri=${keyVaultUri}secrets/${storageConnectionSecretName}/)'

resource plan 'Microsoft.Web/serverfarms@2022-09-01' = {
  name: planName
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: planSkuName
    tier: planTier
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2022-09-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOTNET-ISOLATED|8.0'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appSettings: [
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'dotnet-isolated'
        }
        {
          name: 'AzureWebJobsStorage'
          value: keyVaultStorageReference
        }
        {
          name: 'AZURE_CLIENT_ID'
          value: identityClientId
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsConnectionString
        }
        {
          name: 'ConnectionStrings__ServiceBus'
          value: keyVaultServiceBusReference
        }
        {
          name: 'ConnectionStrings__Cosmos'
          value: keyVaultCosmosReference
        }
        {
          name: 'ConnectionStrings__Storage'
          value: keyVaultStorageReference
        }
        {
          name: 'Azure__ServiceBus__FullyQualifiedNamespace'
          value: serviceBusFullyQualifiedNamespace
        }
        {
          name: 'Azure__Cosmos__AccountEndpoint'
          value: cosmosAccountEndpoint
        }
        {
          name: 'Azure__Storage__BlobServiceUri'
          value: storageBlobServiceUri
        }
        {
          name: 'Azure__KeyVault__VaultUri'
          value: keyVaultUri
        }
        {
          name: 'Azure__Identity__ManagedIdentityClientId'
          value: identityClientId
        }
      ]
    }
  }
}

@description('Full ARM resource id of the App Service plan.')
output planId string = resourceId('Microsoft.Web/serverfarms', planName)

@description('Full ARM resource id of the Linux function app.')
output functionAppId string = resourceId('Microsoft.Web/sites', functionAppName)
