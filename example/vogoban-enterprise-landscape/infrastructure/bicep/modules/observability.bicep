@description('Azure region for the observability resources.')
param location string

@description('Log Analytics workspace name, vg-enterprise-logs.')
param logAnalyticsName string

@description('Application Insights component name, vg-enterprise-appinsights.')
param appInsightsName string

@minValue(30)
@maxValue(730)
@description('Log Analytics retention in days.')
param retentionInDays int = 30

@description('Tags applied to every resource in this module.')
param tags object = {}

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalyticsWorkspace.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

@description('Full ARM resource id of the Log Analytics workspace.')
output workspaceId string = resourceId('Microsoft.OperationalInsights/workspaces', logAnalyticsName)

@description('Workspace id (customer id) the Container Apps environment logs into.')
output workspaceCustomerId string = logAnalyticsWorkspace.properties.customerId

@description('Full ARM resource id of the Application Insights component.')
output appInsightsId string = resourceId('Microsoft.Insights/components', appInsightsName)

@description('Connection string the deployed services and the function app write telemetry with.')
output appInsightsConnectionString string = appInsights.properties.ConnectionString
