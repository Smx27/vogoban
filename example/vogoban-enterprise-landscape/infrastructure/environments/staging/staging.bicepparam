using '../../bicep/main.bicep'

param environment = 'staging'
param location = 'westeurope'

param serviceBusSkuName = 'Premium'
param cosmosMaxAutoscaleThroughput = 4000
param storageSkuName = 'Standard_ZRS'
param logAnalyticsRetentionInDays = 90
param functionAppPlanSkuName = 'EP1'
param containerAppMinReplicas = 1
param containerAppMaxReplicas = 4
param notificationServiceMaxReplicas = 10
param queueMessageCountThreshold = 10
param containerImageRegistry = 'vgentacr.azurecr.io'
param containerImageTag = '1.0.0-rc'
