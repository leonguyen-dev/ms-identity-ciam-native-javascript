<#
.SYNOPSIS
    Register the OnAttributeCollectionSubmit custom authentication extension in Entra
    and attach it to a sign-up user flow — via Microsoft Graph.

.DESCRIPTION
    Step 2 of wiring attribute-submit-function into Entra. Run after
    1-provision-and-deploy.ps1 and after the function is protected with Easy Auth.

    What it does:
      1. Connects to Microsoft Graph (CustomAuthenticationExtension.ReadWrite.All,
         EventListener.ReadWrite.All).
      2. Reuses the SAME authenticationConfiguration.resourceId as the working
         OnOtpSend extension, so no new app registration or admin consent is needed
         (the custom-extension service principal is already consented for that
         resource app).
      3. Creates the onAttributeCollectionSubmitCustomExtension.
      4. PATCHes the chosen user flow's onAttributeCollectionSubmit handler to point
         at the new extension.

    Requires: Microsoft.Graph PowerShell SDK
        Install-Module Microsoft.Graph -Scope CurrentUser

.NOTES
    Schemas verified against Graph v1.0:
      - https://learn.microsoft.com/graph/api/identitycontainer-post-customauthenticationextensions
      - https://learn.microsoft.com/graph/api/authenticationeventsflow-update
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$TargetUrl,                 # from step 1 (includes ?code=)
    [string]$TenantId   = "a67366e7-9873-4a38-9bae-0a4a18952688",  # myservicetasdevpoc
    [string]$DisplayName = "ServiceTas - On Attribute Collection Submit",
    [string]$Description = "Validates sign-up email (mock /Portal/checkAccess) and registers the user in TFS (mock /B2CPortal/createSignUp).",

    # Optional overrides. If blank, the script discovers them:
    #   ResourceId  - copied from the existing OnOtpSend extension.
    #   FlowId      - chosen interactively from your sign-up user flows.
    [string]$ResourceId = "",
    [string]$FlowId     = ""
)

$ErrorActionPreference = "Stop"

Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
Connect-MgGraph -TenantId $TenantId -Scopes "CustomAuthenticationExtension.ReadWrite.All","EventListener.ReadWrite.All" -NoWelcome

# --- 1. Resolve the resourceId (reuse the OTP extension's, for shared consent) -------------
if (-not $ResourceId) {
    Write-Host "==> Discovering resourceId from the existing OnOtpSend extension..."
    $exts = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/identity/customAuthenticationExtensions").value
    $otp  = $exts | Where-Object { $_.'@odata.type' -eq '#microsoft.graph.onOtpSendCustomExtension' } | Select-Object -First 1
    if (-not $otp) { throw "No OnOtpSend extension found to copy resourceId from. Pass -ResourceId explicitly." }
    $ResourceId = $otp.authenticationConfiguration.resourceId
    Write-Host "    Reusing resourceId: $ResourceId"
}

# --- 2. Create the OnAttributeCollectionSubmit custom extension -----------------------------
$body = @{
    "@odata.type" = "#microsoft.graph.onAttributeCollectionSubmitCustomExtension"
    displayName   = $DisplayName
    description   = $Description
    authenticationConfiguration = @{
        "@odata.type" = "#microsoft.graph.azureAdTokenAuthentication"
        resourceId    = $ResourceId
    }
    endpointConfiguration = @{
        "@odata.type" = "#microsoft.graph.httpRequestEndpoint"
        targetUrl     = $TargetUrl
    }
    clientConfiguration = @{
        timeoutInMilliseconds = 2000
        maximumRetries        = 1
    }
}

Write-Host "==> Creating custom extension '$DisplayName'..."
$created = Invoke-MgGraphRequest -Method POST `
    -Uri "https://graph.microsoft.com/v1.0/identity/customAuthenticationExtensions" `
    -Body ($body | ConvertTo-Json -Depth 10)
$extensionId = $created.id
Write-Host "    Created extension id: $extensionId" -ForegroundColor Green

# --- 3. Pick the user flow to attach to -----------------------------------------------------
if (-not $FlowId) {
    Write-Host "==> Your self-service sign-up user flows:"
    $flows = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/identity/authenticationEventsFlows").value
    $i = 0
    $flows | ForEach-Object { Write-Host ("  [{0}] {1}  ({2})" -f $i++, $_.displayName, $_.id) }
    $sel = Read-Host "Select the flow number to attach the extension to"
    $FlowId = $flows[[int]$sel].id
}

# --- 4. Attach the extension to the flow's onAttributeCollectionSubmit handler --------------
$patch = @{
    "@odata.type" = "#microsoft.graph.externalUsersSelfServiceSignUpEventsFlow"
    onAttributeCollectionSubmit = @{
        "@odata.type"   = "#microsoft.graph.onAttributeCollectionSubmitCustomExtensionHandler"
        customExtension = @{ id = $extensionId }
    }
}

Write-Host "==> Attaching extension to flow $FlowId..."
Invoke-MgGraphRequest -Method PATCH `
    -Uri "https://graph.microsoft.com/v1.0/identity/authenticationEventsFlows/$FlowId" `
    -Body ($patch | ConvertTo-Json -Depth 10) | Out-Null

Write-Host "`n=========================================================="
Write-Host "Done. OnAttributeCollectionSubmit extension is wired up." -ForegroundColor Green
Write-Host "  Extension id : $extensionId"
Write-Host "  Resource id  : $ResourceId"
Write-Host "  User flow    : $FlowId"
Write-Host "`nVerify in Entra admin center -> External Identities -> User flows ->"
Write-Host "  <your flow> -> Custom authentication extensions, or test a sign-up."
Write-Host "=========================================================="
