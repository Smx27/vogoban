param accountName string
param location string

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: accountName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    locations: [ { locationName: location } ]
    disableLocalAuth: false
    publicNetworkAccess: 'Enabled'
  }
}

resource db 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: account
  name: 'ordersdb'
  properties: { resource: { id: 'ordersdb' } }
}

resource orders 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: db
  name: 'orders'
  properties: {
    resource: {
      id: 'orders'
      partitionKey: { paths: [ '/id' ], kind: 'Hash' }
    }
  }
}

resource leases 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: db
  name: 'leases'
  properties: { resource: { id: 'leases', partitionKey: { paths: [ '/id' ] } } }
}

output endpoint string = account.properties.documentEndpoint
