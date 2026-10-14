@description('One container app in the vg-enterprise Container Apps environment.')
type containerAppDefinition = {
  @description('Container app name, for example vg-orders-api.')
  name: string

  @description('Whether the app publishes an external ingress.')
  external: bool

  @minValue(0)
  @description('Minimum replica count.')
  minReplicas: int

  @minValue(1)
  @description('Maximum replica count.')
  maxReplicas: int

  @description('Service Bus queue this app scales on. Empty when the app is not queue-driven.')
  queueName: string
}

@description('Azure region for the environment and the container apps.')
param location string

@description('Container Apps environment name, vg-enterprise-aca-env.')
param environmentName string

@description('Full ARM resource id of the Log Analytics workspace the environment forwards container logs to.')
param logAnalyticsWorkspaceId string

@description('Workspace id (customer id) of that Log Analytics workspace.')
param logAnalyticsCustomerId string

@description('Registry the container app images are pulled from.')
param imageRegistry string

@description('Image tag deployed to every container app.')
param imageTag string

@description('Container apps to create, one per deployment unit.')
param apps containerAppDefinition[] = []

@description('Resource id of the user-assigned managed identity every app runs as.')
param identityId string

@description('Client id of that identity, exported as AZURE_CLIENT_ID.')
param identityClientId string

@description('Vault URI the container app secrets are resolved from.')
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

@minValue(1)
@description('Queue length a KEDA azure-servicebus rule scales on.')
param queueMessageCountThreshold int = 10

@description('Tags applied to every resource in this module.')
param tags object = {}

var serviceBusConnectionSecret = 'servicebus-connection'
var cosmosConnectionSecret = 'cosmos-connection'
var storageConnectionSecret = 'storage-connection'

resource environment 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: listKeys(logAnalyticsWorkspaceId, '2022-10-01').primarySharedKey
      }
    }
  }
}

resource containerApp 'Microsoft.App/containerApps@2023-05-01' = [for app in apps: {
  name: app.name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: app.external
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
      }
      secrets: [
        {
          name: serviceBusConnectionSecret
          keyVaultUrl: '${keyVaultUri}secrets/${serviceBusConnectionSecretName}'
          identity: identityId
        }
        {
          name: cosmosConnectionSecret
          keyVaultUrl: '${keyVaultUri}secrets/${cosmosConnectionSecretName}'
          identity: identityId
        }
        {
          name: storageConnectionSecret
          keyVaultUrl: '${keyVaultUri}secrets/${storageConnectionSecretName}'
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: app.name
          image: '${imageRegistry}/${app.name}:${imageTag}'
          env: concat(
            [
              {
                name: 'AZURE_CLIENT_ID'
                value: identityClientId
              }
              {
                name: 'ASPNETCORE_HTTP_PORTS'
                value: '8080'
              }
              {
                name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
                value: appInsightsConnectionString
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
            ],
            [
              {
                name: 'ConnectionStrings__ServiceBus'
                secretRef: serviceBusConnectionSecret
              }
              {
                name: 'ConnectionStrings__Cosmos'
                secretRef: cosmosConnectionSecret
              }
              {
                name: 'ConnectionStrings__Storage'
                secretRef: storageConnectionSecret
              }
            ]
          )
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: app.minReplicas
        maxReplicas: app.maxReplicas
        rules: [for queueName in (app.queueName == '' ? [] : [app.queueName]): {
          name: 'servicebus-queue'
          custom: {
            type: 'azure-servicebus'
            metadata: {
              queueName: queueName
              messageCount: string(queueMessageCountThreshold)
            }
            auth: [
              {
                secretRef: serviceBusConnectionSecret
                triggerParameter: 'connection'
              }
            ]
          }
        }]
      }
    }
  }
}]

@description('Full ARM resource id of the Container Apps environment.')
output environmentId string = resourceId('Microsoft.App/managedEnvironments', environmentName)

@description('One deployment unit and its full ARM resource id.')
type containerAppId = {
  @description('Container app name, for example vg-orders-api.')
  name: string

  @description('Full ARM resource id of the container app.')
  id: string
}

@description('Full ARM resource ids of the container apps, one entry per deployment unit.')
output containerAppIds containerAppId[] = [for app in apps: {
  name: app.name
  id: resourceId('Microsoft.App/containerApps', app.name)
}]
