@description('Azure region for the storage account.')
param location string

@description('Logical storage account name, vgentstorage.')
param accountName string

@allowed([
  'Standard_LRS'
  'Standard_ZRS'
  'Standard_GRS'
  'Premium_LRS'
])
@description('Replication SKU of the storage account.')
param skuName string = 'Standard_LRS'

@description('Blob container holding notification payloads.')
param notificationPayloadsContainerName string

@description('Blob container holding report artifacts.')
param reportArtifactsContainerName string

@description('Tags applied to every resource in this module.')
param tags object = {}

resource account 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: accountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: skuName
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: account
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource notificationPayloads 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: notificationPayloadsContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource reportArtifacts 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: reportArtifactsContainerName
  properties: {
    publicAccess: 'None'
  }
}

@description('Blob service URI, https://vgentstorage.blob.core.windows.net/.')
output blobServiceUri string = account.properties.primaryEndpoints.blob

@description('Full ARM resource id of the storage account.')
output accountId string = resourceId('Microsoft.Storage/storageAccounts', accountName)

@description('Full ARM resource id of the vg-notification-payloads container.')
output notificationPayloadsContainerId string = resourceId('Microsoft.Storage/storageAccounts/blobServices/containers', accountName, 'default', notificationPayloadsContainerName)

@description('Full ARM resource id of the vg-report-artifacts container.')
output reportArtifactsContainerId string = resourceId('Microsoft.Storage/storageAccounts/blobServices/containers', accountName, 'default', reportArtifactsContainerName)
