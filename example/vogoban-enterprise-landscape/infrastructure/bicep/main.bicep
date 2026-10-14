targetScope = 'resourceGroup'

@description('Azure region. Defaults to the region of the target resource group.')
param location string = resourceGroup().location

@description('Environment layer this deployment represents. Resource names stay identical across environments; only sizing and this label change.')
param environment string = 'dev'

@description('Service Bus namespace, vg-enterprise-servicebus.')
param serviceBusNamespaceName string = 'vg-enterprise-servicebus'

@description('Topic carrying order lifecycle events, vg-order-events.')
param orderEventsTopicName string = 'vg-order-events'

@description('Subscription on the topic consumed by the order-processing function.')
param orderProcessorSubscriptionName string = 'vg-order-processor'

@description('Subscription on the topic consumed by the notification service.')
param notificationsSubscriptionName string = 'vg-notifications'

@description('Queue the notification service consumes and KEDA scales on.')
param notificationRequestsQueueName string = 'vg-notification-requests'

@description('Queue the reporting platform consumes.')
param reportJobsQueueName string = 'vg-report-jobs'

@allowed([
  'Basic'
  'Standard'
  'Premium'
])
@description('Service Bus tier.')
param serviceBusSkuName string = 'Standard'

@description('Cosmos DB account, vg-enterprise-cosmos.')
param cosmosAccountName string = 'vg-enterprise-cosmos'

@description('SQL database shared by every service, vg-enterprise.')
param cosmosDatabaseName string = 'vg-enterprise'

@description('Container holding orders, partitioned by /customerId.')
param cosmosOrdersContainerName string = 'vg-orders'

@description('Container holding customers, partitioned by /id.')
param cosmosCustomersContainerName string = 'vg-customers'

@description('Container holding reports, partitioned by /reportType.')
param cosmosReportsContainerName string = 'vg-reports'

@minValue(1000)
@maxValue(1000000)
@description('Autoscale ceiling in RU/s applied to every Cosmos container.')
param cosmosMaxAutoscaleThroughput int = 4000

@description('Storage account, vgentstorage.')
param storageAccountName string = 'vgentstorage'

@allowed([
  'Standard_LRS'
  'Standard_ZRS'
  'Standard_GRS'
  'Premium_LRS'
])
@description('Storage replication SKU.')
param storageSkuName string = 'Standard_LRS'

@description('Blob container holding notification payloads.')
param notificationPayloadsContainerName string = 'vg-notification-payloads'

@description('Blob container holding report artifacts.')
param reportArtifactsContainerName string = 'vg-report-artifacts'

@description('Key Vault, vg-enterprise-kv.')
param keyVaultName string = 'vg-enterprise-kv'

@description('Secret holding the Service Bus connection string.')
param serviceBusConnectionSecretName string = 'vg-servicebus-connection'

@description('Secret holding the Cosmos DB connection string.')
param cosmosConnectionSecretName string = 'vg-cosmos-connection'

@description('Secret holding the storage connection string.')
param storageConnectionSecretName string = 'vg-storage-connection'

@description('User-assigned managed identity every workload runs as, vg-enterprise-identity.')
param identityName string = 'vg-enterprise-identity'

@description('Log Analytics workspace, vg-enterprise-logs.')
param logAnalyticsName string = 'vg-enterprise-logs'

@minValue(30)
@maxValue(730)
@description('Log Analytics retention in days.')
param logAnalyticsRetentionInDays int = 30

@description('Application Insights component, vg-enterprise-appinsights.')
param appInsightsName string = 'vg-enterprise-appinsights'

@description('App Service plan, vg-enterprise-plan.')
param appServicePlanName string = 'vg-enterprise-plan'

@allowed([
  'Y1'
  'EP1'
  'EP2'
  'EP3'
])
@description('App Service plan SKU of the function app.')
param functionAppPlanSkuName string = 'Y1'

@description('Linux function app, vg-order-processor-function.')
param functionAppName string = 'vg-order-processor-function'

@description('Container Apps environment, vg-enterprise-aca-env.')
param containerAppsEnvironmentName string = 'vg-enterprise-aca-env'

@description('Deployment unit served by the gateway container app.')
param platformGatewayAppName string = 'vg-platform-gateway'

@description('Deployment unit served by the orders container app.')
param ordersApiAppName string = 'vg-orders-api'

@description('Deployment unit served by the customers container app.')
param customersApiAppName string = 'vg-customers-api'

@description('Deployment unit served by the notification container app.')
param notificationServiceAppName string = 'vg-notification-service'

@description('Registry the container app images are pulled from.')
param containerImageRegistry string = 'vgentacr.azurecr.io'

@description('Image tag deployed to every container app.')
param containerImageTag string = '1.0.0'

@minValue(0)
@description('Minimum replica count of every container app.')
param containerAppMinReplicas int = 1

@minValue(1)
@description('Maximum replica count of the gateway, orders and customers apps.')
param containerAppMaxReplicas int = 3

@minValue(1)
@description('Maximum replica count of the notification service, which scales on the Service Bus queue.')
param notificationServiceMaxReplicas int = 10

@minValue(1)
@description('Queue length the KEDA azure-servicebus rule scales on.')
param queueMessageCountThreshold int = 10

var tags = {
  'vg:system': 'vg-enterprise'
  'vg:repository': 'infrastructure'
  'vg:environment': environment
}

var placeholderAccountKey = '0000000000000000000000000000000000000000000000000000000000000000=='
var placeholderSharedAccessKey = '0000000000000000000000000000000000000000000000='

var containerAppDefinitions = [
  {
    name: platformGatewayAppName
    external: true
    minReplicas: containerAppMinReplicas
    maxReplicas: containerAppMaxReplicas
    queueName: ''
  }
  {
    name: ordersApiAppName
    external: false
    minReplicas: containerAppMinReplicas
    maxReplicas: containerAppMaxReplicas
    queueName: ''
  }
  {
    name: customersApiAppName
    external: false
    minReplicas: containerAppMinReplicas
    maxReplicas: containerAppMaxReplicas
    queueName: ''
  }
  {
    name: notificationServiceAppName
    external: false
    minReplicas: containerAppMinReplicas
    maxReplicas: notificationServiceMaxReplicas
    queueName: notificationRequestsQueueName
  }
]

module serviceBus 'modules/servicebus.bicep' = {
  name: 'servicebus'
  params: {
    location: location
    namespaceName: serviceBusNamespaceName
    topicName: orderEventsTopicName
    orderProcessorSubscriptionName: orderProcessorSubscriptionName
    notificationsSubscriptionName: notificationsSubscriptionName
    notificationRequestsQueueName: notificationRequestsQueueName
    reportJobsQueueName: reportJobsQueueName
    skuName: serviceBusSkuName
    tags: tags
  }
}

module cosmos 'modules/cosmos.bicep' = {
  name: 'cosmos'
  params: {
    location: location
    accountName: cosmosAccountName
    databaseName: cosmosDatabaseName
    ordersContainerName: cosmosOrdersContainerName
    customersContainerName: cosmosCustomersContainerName
    reportsContainerName: cosmosReportsContainerName
    maxAutoscaleThroughput: cosmosMaxAutoscaleThroughput
    tags: tags
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    accountName: storageAccountName
    skuName: storageSkuName
    notificationPayloadsContainerName: notificationPayloadsContainerName
    reportArtifactsContainerName: reportArtifactsContainerName
    tags: tags
  }
}

module keyVault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    location: location
    vaultName: keyVaultName
    tenantId: subscription().tenantId
    secrets: [
      {
        name: serviceBusConnectionSecretName
        value: 'Endpoint=sb://${serviceBusNamespaceName}.servicebus.windows.net/;SharedAccessKeyName=placeholder-policy;SharedAccessKey=${placeholderSharedAccessKey}'
      }
      {
        name: cosmosConnectionSecretName
        value: 'AccountEndpoint=https://${cosmosAccountName}.documents.azure.com:443/;AccountKey=${placeholderAccountKey}'
      }
      {
        name: storageConnectionSecretName
        value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccountName};AccountKey=${placeholderAccountKey};EndpointSuffix=core.windows.net'
      }
    ]
    tags: tags
  }
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  dependsOn: [
    serviceBus
    cosmos
    storage
    keyVault
  ]
  params: {
    location: location
    identityName: identityName
    serviceBusNamespaceName: serviceBusNamespaceName
    cosmosAccountName: cosmosAccountName
    storageAccountName: storageAccountName
    keyVaultName: keyVaultName
    tags: tags
  }
}

module observability 'modules/observability.bicep' = {
  name: 'observability'
  params: {
    location: location
    logAnalyticsName: logAnalyticsName
    appInsightsName: appInsightsName
    retentionInDays: logAnalyticsRetentionInDays
    tags: tags
  }
}

module functionApp 'modules/functionapp.bicep' = {
  name: 'functionapp'
  params: {
    location: location
    planName: appServicePlanName
    functionAppName: functionAppName
    planSkuName: functionAppPlanSkuName
    identityId: identity.outputs.identityId
    identityClientId: identity.outputs.clientId
    keyVaultUri: keyVault.outputs.vaultUri
    serviceBusConnectionSecretName: serviceBusConnectionSecretName
    cosmosConnectionSecretName: cosmosConnectionSecretName
    storageConnectionSecretName: storageConnectionSecretName
    serviceBusFullyQualifiedNamespace: serviceBus.outputs.fullyQualifiedNamespace
    cosmosAccountEndpoint: cosmos.outputs.accountEndpoint
    storageBlobServiceUri: storage.outputs.blobServiceUri
    appInsightsConnectionString: observability.outputs.appInsightsConnectionString
    tags: tags
  }
}

module containerApps 'modules/containerapps.bicep' = {
  name: 'containerapps'
  params: {
    location: location
    environmentName: containerAppsEnvironmentName
    logAnalyticsWorkspaceId: observability.outputs.workspaceId
    logAnalyticsCustomerId: observability.outputs.workspaceCustomerId
    imageRegistry: containerImageRegistry
    imageTag: containerImageTag
    apps: containerAppDefinitions
    identityId: identity.outputs.identityId
    identityClientId: identity.outputs.clientId
    keyVaultUri: keyVault.outputs.vaultUri
    serviceBusConnectionSecretName: serviceBusConnectionSecretName
    cosmosConnectionSecretName: cosmosConnectionSecretName
    storageConnectionSecretName: storageConnectionSecretName
    serviceBusFullyQualifiedNamespace: serviceBus.outputs.fullyQualifiedNamespace
    cosmosAccountEndpoint: cosmos.outputs.accountEndpoint
    storageBlobServiceUri: storage.outputs.blobServiceUri
    appInsightsConnectionString: observability.outputs.appInsightsConnectionString
    queueMessageCountThreshold: queueMessageCountThreshold
    tags: tags
  }
}

@description('Full ARM resource id of the resource group every id below is rooted in.')
output resourceGroupId string = resourceGroup().id

@description('Full ARM resource id of the vg-enterprise-servicebus namespace.')
output serviceBusNamespaceId string = serviceBus.outputs.namespaceId

@description('Full ARM resource id of the vg-order-events topic.')
output orderEventsTopicId string = serviceBus.outputs.topicId

@description('Full ARM resource id of the vg-notification-requests queue.')
output notificationRequestsQueueId string = serviceBus.outputs.notificationRequestsQueueId

@description('Full ARM resource id of the vg-report-jobs queue.')
output reportJobsQueueId string = serviceBus.outputs.reportJobsQueueId

@description('Full ARM resource id of the vg-enterprise-cosmos account.')
output cosmosAccountId string = cosmos.outputs.accountId

@description('Full ARM resource id of the vg-enterprise database.')
output cosmosDatabaseId string = cosmos.outputs.databaseId

@description('Full ARM resource id of the vg-orders container.')
output cosmosOrdersContainerId string = cosmos.outputs.ordersContainerId

@description('Full ARM resource id of the vg-customers container.')
output cosmosCustomersContainerId string = cosmos.outputs.customersContainerId

@description('Full ARM resource id of the vg-reports container.')
output cosmosReportsContainerId string = cosmos.outputs.reportsContainerId

@description('Full ARM resource id of the vault.')
output keyVaultId string = keyVault.outputs.vaultId

@description('Full ARM resource id of the user-assigned managed identity.')
output managedIdentityId string = identity.outputs.identityId

@description('Full ARM resource id of the Linux function app.')
output functionAppId string = functionApp.outputs.functionAppId

@description('Full ARM resource id of the App Service plan.')
output appServicePlanId string = functionApp.outputs.planId

@description('Full ARM resource id of the storage account.')
output storageAccountId string = storage.outputs.accountId

@description('Full ARM resource id of the vg-notification-payloads container.')
output notificationPayloadsContainerId string = storage.outputs.notificationPayloadsContainerId

@description('Full ARM resource id of the vg-report-artifacts container.')
output reportArtifactsContainerId string = storage.outputs.reportArtifactsContainerId

@description('Full ARM resource id of the Container Apps environment.')
output containerAppsEnvironmentId string = containerApps.outputs.environmentId

@description('Full ARM resource ids of the four container apps, one entry per deployment unit.')
output containerAppIds array = containerApps.outputs.containerAppIds

@description('Full ARM resource id of the Log Analytics workspace.')
output logAnalyticsWorkspaceId string = observability.outputs.workspaceId

@description('Full ARM resource id of the Application Insights component.')
output appInsightsId string = observability.outputs.appInsightsId

@description('Vault URI every Key Vault reference resolves against, https://vg-enterprise-kv.vault.azure.net/.')
output keyVaultUri string = keyVault.outputs.vaultUri

@description('Client id the workloads present as AZURE_CLIENT_ID.')
output managedIdentityClientId string = identity.outputs.clientId

@description('Fully qualified Service Bus namespace, vg-enterprise-servicebus.servicebus.windows.net.')
output serviceBusFullyQualifiedNamespace string = serviceBus.outputs.fullyQualifiedNamespace

@description('Cosmos DB account endpoint, https://vg-enterprise-cosmos.documents.azure.com:443/.')
output cosmosAccountEndpoint string = cosmos.outputs.accountEndpoint

@description('Blob service URI, https://vgentstorage.blob.core.windows.net/.')
output storageBlobServiceUri string = storage.outputs.blobServiceUri
