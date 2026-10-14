using '../main.bicep'

param environment = 'dev'
param location = 'westeurope'

param serviceBusSkuName = 'Standard'
param cosmosMaxAutoscaleThroughput = 1000
param storageSkuName = 'Standard_LRS'
param logAnalyticsRetentionInDays = 30
param functionAppPlanSkuName = 'Y1'
param containerAppMinReplicas = 0
param containerAppMaxReplicas = 2
param notificationServiceMaxReplicas = 5
param queueMessageCountThreshold = 10
param containerImageRegistry = 'vgentacr.azurecr.io'
param containerImageTag = '1.0.0-dev'
