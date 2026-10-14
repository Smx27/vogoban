@description('Azure region for the Cosmos DB account.')
param location string

@description('Logical account name, vg-enterprise-cosmos.')
param accountName string

@description('SQL database shared by every service, vg-enterprise.')
param databaseName string

@description('Container holding orders, partitioned by /customerId.')
param ordersContainerName string

@description('Container holding customers, partitioned by /id.')
param customersContainerName string

@description('Container holding reports, partitioned by /reportType.')
param reportsContainerName string

@minValue(1000)
@maxValue(1000000)
@description('Autoscale ceiling in RU/s applied to every container.')
param maxAutoscaleThroughput int = 4000

@description('Tags applied to every resource in this module.')
param tags object = {}

resource account 'Microsoft.DocumentDB/databaseAccounts@2023-04-15' = {
  name: accountName
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    publicNetworkAccess: 'Enabled'
    enableFreeTier: false
    disableKeyBasedMetadataWriteAccess: false
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
      maxIntervalInSeconds: 5
      maxStalenessPrefix: 100
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2023-04-15' = {
  parent: account
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
  }
}

resource ordersContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2023-04-15' = {
  parent: database
  name: ordersContainerName
  properties: {
    resource: {
      id: ordersContainerName
      partitionKey: {
        paths: [
          '/customerId'
        ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
      }
    }
    options: {
      autoscaleSettings: {
        maxThroughput: maxAutoscaleThroughput
      }
    }
  }
}

resource customersContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2023-04-15' = {
  parent: database
  name: customersContainerName
  properties: {
    resource: {
      id: customersContainerName
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
      }
    }
    options: {
      autoscaleSettings: {
        maxThroughput: maxAutoscaleThroughput
      }
    }
  }
}

resource reportsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2023-04-15' = {
  parent: database
  name: reportsContainerName
  properties: {
    resource: {
      id: reportsContainerName
      partitionKey: {
        paths: [
          '/reportType'
        ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
      }
    }
    options: {
      autoscaleSettings: {
        maxThroughput: maxAutoscaleThroughput
      }
    }
  }
}

@description('Account endpoint, https://vg-enterprise-cosmos.documents.azure.com:443/.')
output accountEndpoint string = account.properties.documentEndpoint

@description('Full ARM resource id of the Cosmos DB account.')
output accountId string = resourceId('Microsoft.DocumentDB/databaseAccounts', accountName)

@description('Full ARM resource id of the vg-enterprise SQL database.')
output databaseId string = resourceId('Microsoft.DocumentDB/databaseAccounts/sqlDatabases', accountName, databaseName)

@description('Full ARM resource id of the vg-orders container.')
output ordersContainerId string = resourceId('Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers', accountName, databaseName, ordersContainerName)

@description('Full ARM resource id of the vg-customers container.')
output customersContainerId string = resourceId('Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers', accountName, databaseName, customersContainerName)

@description('Full ARM resource id of the vg-reports container.')
output reportsContainerId string = resourceId('Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers', accountName, databaseName, reportsContainerName)
