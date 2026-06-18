<#
.SYNOPSIS
    Rebuild and republish the OnTokenIssuanceStart function code to its EXISTING
    Azure Function App. Use this for code redeploys — it does not provision the app.

.DESCRIPTION
    Builds the TypeScript (npm install + npm run build) and publishes with the
    Azure Functions Core Tools. The Function App, storage, Easy Auth and Graph
    permission must already exist (they were provisioned earlier). To also refresh
    the app settings from this script, pass -SyncSettings.

    Requires: Azure CLI (az) logged in to the right subscription, and Azure
    Functions Core Tools v4 (func) on PATH.

.EXAMPLE
    .\redeploy.ps1
        Build + publish code only.

.EXAMPLE
    .\redeploy.ps1 -SyncSettings
        Build + publish, then push the (non-secret) app settings below.

.NOTES
    GRAPH_CLIENT_SECRET is intentionally NOT set here — in Azure the function uses
    its managed identity. Keep secrets out of source control.
#>

[CmdletBinding()]
param(
    [string]$SubscriptionId = "",                                       # blank = current az account
    [string]$ResourceGroup  = "EntraExternalIDPoC",
    [string]$FunctionApp    = "myservicetas-poc-token-issuance-func",

    # Optional: re-apply app settings (non-secret). Skipped unless this is passed.
    [switch]$SyncSettings,
    [string]$GraphTenantId  = "a67366e7-9873-4a38-9bae-0a4a18952688",
    [string]$GraphClientId  = "02988e45-6cf6-4350-a076-cee803a0db86",
    [string]$PhoneClaimId   = "phoneNumber",
    [string]$GraphTimeoutMs = "1800"
)

$ErrorActionPreference = "Stop"
$funcRoot = Split-Path $PSScriptRoot -Parent   # the token-issuance-function folder

if ($SubscriptionId) { az account set --subscription $SubscriptionId }
Write-Host "Using subscription:" (az account show --query name -o tsv)

# Fail early with a clear message if the target app is missing.
$exists = az functionapp show --name $FunctionApp --resource-group $ResourceGroup --query name -o tsv 2>$null
if (-not $exists) {
    throw "Function App '$FunctionApp' not found in resource group '$ResourceGroup'. This script redeploys an existing app — provision it first."
}

if ($SyncSettings) {
    Write-Host "`n==> Syncing app settings (no secret; managed identity is used in Azure)"
    az functionapp config appsettings set --name $FunctionApp --resource-group $ResourceGroup --settings `
        "GRAPH_TENANT_ID=$GraphTenantId" `
        "GRAPH_CLIENT_ID=$GraphClientId" `
        "PHONE_CLAIM_ID=$PhoneClaimId" `
        "GRAPH_TIMEOUT_MS=$GraphTimeoutMs" -o none
}

Write-Host "`n==> Building + publishing the function code"
Push-Location $funcRoot
try {
    npm install
    npm run build
    func azure functionapp publish $FunctionApp
}
finally {
    Pop-Location
}

$targetUrl = "https://$FunctionApp.azurewebsites.net/api/tokenIssuanceStart"

Write-Host "`n=========================================================="
Write-Host "Redeployed $FunctionApp." -ForegroundColor Green
Write-Host "Endpoint: $targetUrl"
Write-Host "The custom-extension registration + claims-mapping policy are unchanged."
Write-Host "=========================================================="
