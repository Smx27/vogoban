@description('Logical secret name and value pair.')
type secretDefinition = {
  @description('Secret name, for example vg-servicebus-connection.')
  name: string

  @description('Clearly fake placeholder value.')
  value: string
}

@description('Azure region for the vault.')
param location string

@description('Logical vault name, vg-enterprise-kv.')
param vaultName string

@description('Azure AD tenant that owns the vault.')
param tenantId string

@description('Secrets to create, keyed by their logical names.')
param secrets secretDefinition[] = []

@description('Tags applied to every resource in this module.')
param tags object = {}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource secret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [for secretDefinition in secrets: {
  parent: vault
  name: secretDefinition.name
  properties: {
    value: secretDefinition.value
    contentType: 'text/plain'
  }
}]

@description('Vault URI, https://vg-enterprise-kv.vault.azure.net/.')
output vaultUri string = vault.properties.vaultUri

@description('Full ARM resource id of the vault.')
output vaultId string = resourceId('Microsoft.KeyVault/vaults', vaultName)
