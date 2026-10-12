#!/usr/bin/env bash
# Phase 17 hostile-repository suite for the Azure analyzers. Builds a hostile repository, analyzes it inside a
# network namespace with no interfaces under strace, and checks: no process execution besides the analyzer
# toolchain, no network connects, no reads outside the repository/toolchain, no secret canary in the graph, logs or export,
# symlinks and traversal refused, pathological IaC bounded.
set -u
VOGOBAN="$(cd "$(dirname "$0")/../../.." && pwd)"
WORK="${1:-/tmp/azure-security}"
rm -rf "$WORK" && mkdir -p "$WORK"
REPO="$WORK/hostile"
mkdir -p "$REPO/infra/modules" "$REPO/tf" "$REPO/func" "$REPO/outside"
CANARY_KEY="AZCANARYKEY0123456789abcdefghijklmnopqrstuv"
CANARY_PWD="Canary-P@ssw0rd-7781"
CANARY_SECRET_FILE="HOST-SECRET-CANARY-5521"
echo "$CANARY_SECRET_FILE" > "$WORK/host-secret.json"
ln -s "$WORK/host-secret.json" "$REPO/infra/abbreviations.json"
ln -s "$WORK/host-secret.json" "$REPO/infra/modules/linked.bicep"
cat > "$REPO/infra/main.bicep" <<BICEP
@secure()
param adminPassword string = '$CANARY_PWD'
var abbrs = loadJsonContent('./abbreviations.json')
var traversal = loadTextContent('../../../host-secret.json')
module linked './modules/linked.bicep' = { name: 'linked' }
module escape '../../outside.bicep' = { name: 'escape' }
resource sa 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'st\${abbrs.x}'
  location: 'westeurope'
  properties: { allowBlobPublicAccess: true }
}
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = { name: 'kv-hostile' }
resource secret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'db-password'
  properties: { value: '$CANARY_PWD' }
}
resource site 'Microsoft.Web/sites@2023-12-01' = {
  name: 'func-hostile'
  kind: 'functionapp'
  properties: {
    siteConfig: {
      appSettings: [
        { name: 'StorageConnection', value: 'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=$CANARY_KEY' }
        { name: 'Password', value: '$CANARY_PWD' }
        { name: 'Keys', value: 'Endpoint=sb://x.servicebus.windows.net/;SharedAccessKey=\${sa.listKeys().keys[0].value}' }
      ]
    }
  }
}
BICEP
python3 - "$REPO/infra/deep.bicep" <<'PY'
import sys
open(sys.argv[1], "w").write("var deep = " + "[" * 50000 + "]" * 50000 + "\n" + "var str = '" + "a" * 3_000_000 + "'\n")
PY
cat > "$REPO/tf/main.tf" <<TF
resource "null_resource" "pwn" {
  provisioner "local-exec" {
    command = "touch $WORK/PWNED-terraform"
  }
}
resource "azurerm_key_vault_secret" "s" {
  name         = "api-key"
  value        = "$CANARY_KEY"
  key_vault_id = "x"
}
variable "password" {
  type      = string
  sensitive = true
  default   = "$CANARY_PWD"
}
module "escape" {
  source = "../../../../etc"
}
TF
cat > "$REPO/func/host.json" <<'JSON'
{ "version": "2.0", "extensionBundle": { "id": "Microsoft.Azure.Functions.ExtensionBundle", "version": "[4.*, 5.0.0)" } }
JSON
cat > "$REPO/func/local.settings.json" <<JSON
{ "IsEncrypted": false, "Values": { "AzureWebJobsStorage": "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=$CANARY_KEY", "ApiPassword": "$CANARY_PWD", "QueueName": "orders" } }
JSON
mkdir -p "$REPO/func/Hello"
cat > "$REPO/func/Hello/function.json" <<'JSON'
{ "bindings": [ { "type": "queueTrigger", "direction": "in", "name": "msg", "queueName": "%QueueName%", "connection": "AzureWebJobsStorage" } ], "scriptFile": "../../../../etc/passwd" }
JSON
cat > "$REPO/func/package.json" <<JSON
{ "name": "hostile-func", "scripts": { "preinstall": "touch $WORK/PWNED-npm", "postinstall": "touch $WORK/PWNED-npm" } }
JSON
cat > "$REPO/azure.yaml" <<YAML
name: hostile
hooks:
  preprovision:
    shell: sh
    run: touch $WORK/PWNED-azd
services:
  func:
    project: ../../../../etc
    host: function
YAML
cat > "$REPO/infra/azuredeploy.json" <<JSON
{ "\$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#", "contentVersion": "1.0.0.0",
  "parameters": { "pwd": { "type": "securestring", "defaultValue": "$CANARY_PWD" } },
  "resources": [ { "type": "Microsoft.Resources/deploymentScripts", "apiVersion": "2020-10-01", "name": "pwn", "kind": "AzureCLI", "properties": { "scriptContent": "touch $WORK/PWNED-arm" } } ] }
JSON
(cd "$REPO" && git init -q && git add -A >/dev/null 2>&1)

DB="$WORK/graph.db"
pass=0; fail=0
check() { if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }

unshare -rn strace -f -qq -e trace=execve,connect,openat -o "$WORK/strace.log" \
  bun "$VOGOBAN/src/cli/main.ts" analyze "$REPO" --db "$DB" --no-semantic --log-json > "$WORK/analyze.log" 2>&1
rc=$?
check "analysis completes (rc=$rc)" "[ $rc -eq 0 ]"
check "no terraform/bicep/az/azd/npm/node/func/dotnet-run execution" "! grep -E 'execve\\(\"[^\"]*/(terraform|bicep|az|azd|npm|npx|node|func|pwsh|sh|bash)\"' '$WORK/strace.log' | grep -v 'git' | grep -q ."
check "no PWNED marker (provisioner/hooks/scripts never run)" "! ls '$WORK'/PWNED-* >/dev/null 2>&1"
check "no inet connect attempts" "! grep -E 'connect\\(.*(AF_INET|AF_INET6)' '$WORK/strace.log' | grep -q ."
check "host secret file never opened through symlink/traversal" "! grep -F 'host-secret.json' '$WORK/strace.log' | grep -v ENOENT | grep -q ."
check "no /etc reads via traversal (passwd)" "! grep -E 'openat\\(.*\"/etc/passwd\"' '$WORK/strace.log' | grep -q ."
bun "$VOGOBAN/src/cli/main.ts" export --format jsonl --out "$WORK/export.jsonl" --db "$DB" >/dev/null 2>&1
for c in "$CANARY_KEY" "$CANARY_PWD" "$CANARY_SECRET_FILE"; do
  check "canary ${c:0:12}… absent from graph store" "! grep -a -F -q '$c' '$DB' '$DB-wal' 2>/dev/null"
  check "canary ${c:0:12}… absent from export and logs" "! grep -a -F -q '$c' '$WORK/export.jsonl' '$WORK/analyze.log'"
done
check "symlinked IaC skipped with diagnostic" "sqlite3 '$DB' \"select count(*) from diagnostics where code='file-skipped' and file like 'infra/%'\" | grep -qv '^0$'"
check "pathological bicep bounded (diagnostic, no crash)" "sqlite3 '$DB' \"select count(*) from files where path='infra/deep.bicep'\" | grep -q 1"
check "secret-named app settings stored without value" "[ \"\$(sqlite3 '$DB' \"select count(*) from entities where kind='SecretReference' and json_extract(metadata,'\$.value') is not null\")\" = 0 ]"
check "storage public access finding produced from static declaration" "bun '$VOGOBAN/src/cli/main.ts' security-findings --db '$DB' --json 2>/dev/null | grep -q AZURE_STORAGE_PUBLIC_BLOB_ACCESS"
echo "{\"pass\": $pass, \"fail\": $fail}"
[ $fail -eq 0 ]
