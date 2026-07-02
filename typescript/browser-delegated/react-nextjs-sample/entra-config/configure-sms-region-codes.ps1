<#
.SYNOPSIS
    Restrict SMS MFA telephony to Australia (+61) and New Zealand (+64) for the
    browser-delegated SPA app — via the Graph onPhoneMethodLoadStart event policy.

.DESCRIPTION
    Implements https://learn.microsoft.com/entra/external-id/customers/how-to-region-code-opt-in
    (preview) as an ALLOWLIST. The policy itself only supports include/exclude
    lists on top of a read-only Microsoft default list (smsOptions.defaultRegions),
    so "enable only 61 and 64" is achieved by:

      1. Creating (or reusing) an onPhoneMethodLoadStartListener scoped to the app.
      2. Reading the read-only smsOptions.defaultRegions list off the listener.
      3. PATCHing smsOptions.excludeRegions = defaultRegions minus the allowed set,
         and smsOptions.includeAdditionalRegions = allowed codes not already in
         defaultRegions (none, for 61/64 — both are default-enabled).

    Opt-in-only regions (the Table 1 list in the doc) stay disabled because
    nothing is added to includeAdditionalRegions beyond the allowed set.

    Country-picker default: the policy has no "default country" property. With
    only Australia and New Zealand left in the picker, Entra pre-selects by
    browser locale when it matches, otherwise the first entry — Australia (+61).

    Requires: Microsoft.Graph PowerShell SDK
        Install-Module Microsoft.Graph.Authentication -Scope CurrentUser
    Role: Authentication Extensibility Administrator or Application Administrator
    (delegated scope EventListener.ReadWrite.All).

.NOTES
    - The listener is scoped to the app via conditions.applications. The native-auth
      sample currently shares this client ID, so its SMS challenges are restricted too.
    - Voice MFA options are left untouched (voice isn't enabled for this tenant).
    - Re-runnable: updates the existing listener instead of creating duplicates.
    - Undo: delete the listener —
        DELETE /v1.0/identity/authenticationEventListeners/{id}
#>

[CmdletBinding()]
param(
    [string]$TenantId = "a67366e7-9873-4a38-9bae-0a4a18952688",   # myservicetasdevpoc
    [string]$AppId    = "5f0a52ca-f5db-4a6d-9b3a-3180d51fdd08",   # ServiceTas Browser POC SPA
    [int[]] $AllowedRegions = @(61, 64),                          # AU, NZ
    [string]$DisplayName = "ServiceTas - SMS regions AU/NZ only"
)

$ErrorActionPreference = "Stop"
# beta, not v1.0: the tenant rejects onPhoneMethodLoadStartListener on v1.0
# ("Invalid OData type") even though the how-to article shows a v1.0 example.
$base = "https://graph.microsoft.com/beta/identity/authenticationEventListeners"

Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
Connect-MgGraph -TenantId $TenantId -Scopes "EventListener.ReadWrite.All" -NoWelcome

# --- 1. Find an existing onPhoneMethodLoadStartListener scoped to this app -----------------
Write-Host "==> Looking for an existing onPhoneMethodLoadStartListener for app $AppId..."
$all = (Invoke-MgGraphRequest -Method GET -Uri $base).value
$listener = $all | Where-Object {
    $_.'@odata.type' -eq '#microsoft.graph.onPhoneMethodLoadStartListener' -and
    ($_.conditions.applications.includeApplications | ForEach-Object {
        if ($_ -is [string]) { $_ } else { $_.appId }
    }) -contains $AppId
} | Select-Object -First 1

# --- 2. Create one if missing (empty options first; we need its defaultRegions) ------------
if (-not $listener) {
    Write-Host "==> None found. Creating listener '$DisplayName'..."
    $createBody = @{
        "@odata.type" = "#microsoft.graph.onPhoneMethodLoadStartListener"
        displayName   = $DisplayName
        priority      = 500
        conditions    = @{
            # authenticationConditionApplication objects — the how-to's plain-string
            # example fails schema validation ("does not match schema").
            applications = @{ includeApplications = @(@{ appId = $AppId }) }
        }
        handler = @{
            "@odata.type" = "#microsoft.graph.onPhoneMethodLoadStartExternalUsersAuthHandler"
            smsOptions   = @{ includeAdditionalRegions = @(); excludeRegions = @() }
            voiceOptions = @{ includeAdditionalRegions = @(); excludeRegions = @() }
        }
    }
    $listener = Invoke-MgGraphRequest -Method POST -Uri $base `
        -Body ($createBody | ConvertTo-Json -Depth 10)
    Write-Host "    Created listener id: $($listener.id)" -ForegroundColor Green
} else {
    Write-Host "    Found listener id: $($listener.id)"
}

# --- 3. Determine the region universe to exclude from --------------------------------------
# Preferred source is the read-only smsOptions.defaultRegions, but the tenant
# returns it EMPTY (observed 2026-07-02), so fall back to the full ITU country
# calling code list. Excluding a code that is already deactivated is harmless,
# and it future-proofs against Microsoft default-enabling more regions.
$ituCallingCodes = @(
    1, 7, 20, 27, 30, 31, 32, 33, 34, 36, 39, 40, 41, 43, 44, 45, 46, 47, 48, 49,
    51, 52, 53, 54, 55, 56, 57, 58, 60, 61, 62, 63, 64, 65, 66, 81, 82, 84, 86,
    90, 91, 92, 93, 94, 95, 98,
    211, 212, 213, 216, 218, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229,
    230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244,
    245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 260,
    261, 262, 263, 264, 265, 266, 267, 268, 269, 290, 291, 297, 298, 299,
    350, 351, 352, 353, 354, 355, 356, 357, 358, 359, 370, 371, 372, 373, 374,
    375, 376, 377, 378, 380, 381, 382, 383, 385, 386, 387, 389,
    420, 421, 423,
    500, 501, 502, 503, 504, 505, 506, 507, 508, 509,
    590, 591, 592, 593, 594, 595, 596, 597, 598, 599,
    670, 672, 673, 674, 675, 676, 677, 678, 679, 680, 681, 682, 683, 685, 686,
    687, 688, 689, 690, 691, 692,
    850, 852, 853, 855, 856, 880, 886,
    960, 961, 962, 963, 964, 965, 966, 967, 968, 970, 971, 972, 973, 974, 975,
    976, 977, 992, 993, 994, 995, 996, 998
)

$listener = Invoke-MgGraphRequest -Method GET -Uri "$base/$($listener.id)"
$defaultRegions = @($listener.handler.smsOptions.defaultRegions | ForEach-Object { [int]$_ })
$universe = if ($defaultRegions.Count -gt 0) {
    Write-Host "    Using server defaultRegions ($($defaultRegions.Count) codes)."
    $defaultRegions
} else {
    Write-Host "    defaultRegions is empty on this tenant - using the full ITU calling-code list ($($ituCallingCodes.Count) codes)."
    $ituCallingCodes
}

# --- 4. Compute allowlist: exclude every region in the universe except the allowed ones ----
$exclude = @($universe | Where-Object { $AllowedRegions -notcontains $_ } | Sort-Object)
$include = @($AllowedRegions | Where-Object { $defaultRegions.Count -gt 0 -and $defaultRegions -notcontains $_ })  # empty for 61/64

$patchBody = @{
    "@odata.type" = "#microsoft.graph.onPhoneMethodLoadStartListener"
    displayName   = $DisplayName
    handler = @{
        "@odata.type" = "#microsoft.graph.onPhoneMethodLoadStartExternalUsersAuthHandler"
        smsOptions = @{
            includeAdditionalRegions = @($include)
            excludeRegions           = @($exclude)
        }
        voiceOptions = @{
            includeAdditionalRegions = @($listener.handler.voiceOptions.includeAdditionalRegions)
            excludeRegions           = @($listener.handler.voiceOptions.excludeRegions)
        }
    }
}

Write-Host "==> Restricting SMS to +$($AllowedRegions -join ', +') (excluding $($exclude.Count) default regions)..."
Invoke-MgGraphRequest -Method PATCH -Uri "$base/$($listener.id)" `
    -Body ($patchBody | ConvertTo-Json -Depth 10) | Out-Null

# --- 5. Verify -------------------------------------------------------------------------------
$final = Invoke-MgGraphRequest -Method GET -Uri "$base/$($listener.id)"
$sms = $final.handler.smsOptions
$leaked = @($AllowedRegions | Where-Object { $sms.excludeRegions -contains $_ })
if ($leaked.Count -gt 0) { throw "Allowed region(s) +$($leaked -join ', +') ended up in excludeRegions - aborting." }

Write-Host "`n=========================================================="
Write-Host "Done. SMS telephony policy applied." -ForegroundColor Green
Write-Host "  Listener id        : $($final.id)"
Write-Host "  App scoped         : $AppId"
Write-Host "  Allowed regions    : +$($AllowedRegions -join ', +')"
Write-Host "  Excluded           : $($sms.excludeRegions.Count) codes"
Write-Host "`nTest: run the browser-delegated sign-in, reach the SMS MFA phone step,"
Write-Host "and confirm the country picker offers only Australia (+61, pre-selected"
Write-Host "for AU-locale browsers) and New Zealand (+64)."
Write-Host "=========================================================="
