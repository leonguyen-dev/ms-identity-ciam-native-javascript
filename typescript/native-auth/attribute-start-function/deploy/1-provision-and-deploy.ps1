<#
.SYNOPSIS
    Provision a NEW Azure Function App for the OnAttributeCollectionStart extension,
    set its app settings, and publish the code.

.DESCRIPTION
    Step 1 of wiring attribute-start-function into Entra. Run this, then
    2-register-extension.ps1. Easy Auth (token protection) is handled separately —
    see deploy/README.md ("Protect the function") — because it must mirror the
    identity-provider config already on the OTP function app.

    Requires: Azure CLI (az) logged in to the right subscription, and Azure
    Functions Core Tools v4 (func) on PATH.

.NOTES
    Edit the parameters below before running. FunctionApp and StorageAccount must be
    globally unique. Tip: list your existing apps to copy region / resource group:
        az functionapp list -o table
#>

[CmdletBinding()]
param(
    [string]$SubscriptionId = "",                              # blank = current az account
    [string]$ResourceGroup  = "rg-myservicetas-poc",
    [string]$Location       = "australiaeast",
    [string]$FunctionApp    = "func-st-attr-start-poc",         # must be globally unique
    [string]$StorageAccount = "stattrstartpoc",                # 3-24 lowercase alphanumeric, globally unique

    # Blocklists (comma-separated, case-insensitive). Keep in sync with the React
    # client's emailBlocklist.ts. Domains also match their subdomains.
    [string]$BlockedEmails  = "someone@example.com,blocked@example.com",
    [string]$BlockedDomains = "mailinator.com"
)

$ErrorActionPreference = "Stop"
$funcRoot = Split-Path $PSScriptRoot -Parent   # the attribute-start-function folder

if ($SubscriptionId) { az account set --subscription $SubscriptionId }
Write-Host "Using subscription:" (az account show --query name -o tsv)

Write-Host "`n==> Resource group $ResourceGroup ($Location)"
az group create --name $ResourceGroup --location $Location -o none

Write-Host "==> Storage account $StorageAccount"
az storage account create `
    --name $StorageAccount --resource-group $ResourceGroup --location $Location `
    --sku Standard_LRS -o none

Write-Host "==> Function App $FunctionApp (Node 20, Functions v4, consumption)"
az functionapp create `
    --name $FunctionApp --resource-group $ResourceGroup `
    --storage-account $StorageAccount `
    --consumption-plan-location $Location `
    --runtime node --runtime-version 20 --functions-version 4 `
    --os-type Linux -o none

Write-Host "==> App settings (blocklists)"
az functionapp config appsettings set --name $FunctionApp --resource-group $ResourceGroup --settings `
    "BLOCKED_EMAILS=$BlockedEmails" `
    "BLOCKED_DOMAINS=$BlockedDomains" -o none

Write-Host "==> Building + publishing the function code"
Push-Location $funcRoot
try {
    npm install
    npm run build
    func azure functionapp publish $FunctionApp
}
finally {
    Pop-Location
}

# Build the target URL (including the ?code= host key) for the registration step.
$key = az functionapp keys list --name $FunctionApp --resource-group $ResourceGroup --query "functionKeys.default" -o tsv
$targetUrl = "https://$FunctionApp.azurewebsites.net/api/attributeCollectionStart?code=$key"

Write-Host "`n=========================================================="
Write-Host "Deployed. Target URL for the custom extension:" -ForegroundColor Green
Write-Host $targetUrl
Write-Host "`nNext:"
Write-Host "  1. Protect the function with Easy Auth (see deploy/README.md)."
Write-Host "  2. Run: .\2-register-extension.ps1 -TargetUrl `"$targetUrl`""
Write-Host "=========================================================="
