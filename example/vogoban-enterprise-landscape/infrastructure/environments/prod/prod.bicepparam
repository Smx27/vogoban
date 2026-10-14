using '../../bicep/main.bicep'

param environment = 'prod'
param location = 'westeurope'

param serviceBusSkuName = 'Premium'
param cosmosMaxAutoscaleThroughput = 20000
param storageSkuName = 'Standard_GRS'
param logAnalyticsRetentionInDays = 365
param functionAppPlanSkuName = 'EP2'
param containerAppMinReplicas = 2
param containerAppMaxReplicas = 10
param notificationServiceMaxReplicas = 30
param queueMessageCountThreshold = 25
param containerImageRegistry = 'vgentacr.azurecr.io'
param containerImageTag = '1.0.0'
