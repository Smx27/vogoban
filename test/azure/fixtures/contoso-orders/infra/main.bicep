targetScope = 'resourceGroup'

@description('Deployment environment name')
param environmentName string = 'prod'
param location string = resourceGroup().location
@secure()
param sqlAdminPassword string

var prefix = 'contoso-orders'
var tags = { 'azd-env-name': environmentName }

module monitoring './modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    prefix: prefix
    location: location
  }
}

module messaging './modules/messaging.bicep' = {
  name: 'messaging'
  params: {
    namespaceName: 'sb-${prefix}'
    eventHubsNamespaceName: 'evhns-${prefix}'
    location: location
  }
}

module data './modules/data.bicep' = {
  name: 'data'
  params: {
    accountName: 'cosmos-${prefix}'
    location: location
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${prefix}'
  location: location
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-${prefix}'
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    publicNetworkAccess: 'Enabled'
  }
}

resource sqlPassword 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'sql-admin-password'
  properties: {
    value: sqlAdminPassword
  }
}

resource auditTopic 'Microsoft.EventGrid/topics@2023-12-15-preview' = {
  name: 'egt-${prefix}-audit'
  location: location
}

module apps './modules/apps.bicep' = {
  name: 'apps'
  params: {
    prefix: prefix
    location: location
    tags: tags
    identityId: identity.id
    identityClientId: identity.properties.clientId
    serviceBusNamespace: messaging.outputs.namespaceName
    eventHubsNamespace: messaging.outputs.eventHubsNamespaceName
    cosmosEndpoint: data.outputs.endpoint
    eventGridEndpoint: auditTopic.properties.endpoint
    appInsightsConnectionString: monitoring.outputs.connectionString
    keyVaultName: vault.name
  }
}

resource auditSubscription 'Microsoft.EventGrid/topics/eventSubscriptions@2023-12-15-preview' = {
  parent: auditTopic
  name: 'audit-to-functions'
  properties: {
    destination: {
      endpointType: 'AzureFunction'
      properties: {
        resourceId: '${apps.outputs.functionAppId}/functions/OnOrderAudit'
      }
    }
    filter: {
      includedEventTypes: [ 'Contoso.Orders.Submitted' ]
    }
  }
}

resource sbSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(identity.id, 'sb-sender')
  scope: auditTopic
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'd5a91429-5739-47e2-a06b-3470a27159e7')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource ownerGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(identity.id, 'owner')
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8e3af657-a8ff-443c-a75c-2fe8c4bcb635')
    principalId: identity.properties.principalId
  }
}

resource apim 'Microsoft.ApiManagement/service@2023-05-01-preview' = {
  name: 'apim-${prefix}'
  location: location
  sku: { name: 'Developer', capacity: 1 }
  properties: {
    publisherEmail: 'platform@contoso.example'
    publisherName: 'Contoso'
  }
}

resource ordersApi 'Microsoft.ApiManagement/service/apis@2023-05-01-preview' = {
  parent: apim
  name: 'orders'
  properties: {
    path: 'orders'
    displayName: 'Orders'
    protocols: [ 'https' ]
    subscriptionRequired: true
    serviceUrl: 'https://${apps.outputs.apiHostName}/api'
  }
}

resource createOrderOp 'Microsoft.ApiManagement/service/apis/operations@2023-05-01-preview' = {
  parent: ordersApi
  name: 'create-order'
  properties: {
    displayName: 'Create order'
    method: 'POST'
    urlTemplate: '/orders'
  }
}

output SERVICE_BUS_NAMESPACE string = messaging.outputs.namespaceName
