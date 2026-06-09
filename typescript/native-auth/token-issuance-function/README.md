# Token Issuance Function (Entra External ID → MFA phone claim)

A TypeScript Azure Function (v4 programming model) that implements the Entra
External ID **`OnTokenIssuanceStart`** custom claims provider. Just before a token
is issued, Entra calls this function; the function reads the user's **MFA (SMS)
phone number** from Microsoft Graph and returns it as a custom claim so it can be
emitted into the ID token.

> The MFA phone number is captured during **MFA setup**, not sign-up. It's stored
> as an *authentication method*, not a directory profile attribute, so it can't be
> mapped through the normal **Attributes & Claims** UI — hence this extension.

## How it works

```text
user completes auth  →  Entra is about to issue a token
        │
        ▼
Entra POSTs { authenticationContext: { user: { id } }, ... }  →  this function
        │
        ▼
function calls Graph GET /users/{id}/authentication/phoneMethods
        │
        ▼
returns { claims: { phoneNumber: "+1 …" } }  →  Entra applies the claims
        │                                            mapping policy
        ▼
token issued with phone_number claim
```

A claim returned here only lands in the token if a **claims mapping policy** is
assigned to the app (see [claims-mapping-policy.json](claims-mapping-policy.json)).

## Project layout

| File | Purpose |
| --- | --- |
| `src/functions/tokenIssuanceStart.ts` | HTTP-triggered handler; parses the Entra payload, fetches the phone number, returns the claim action. |
| `src/graphClient.ts` | App-only Microsoft Graph call to `authentication/phoneMethods`. |
| `claims-mapping-policy.json` | Maps the `phoneNumber` provider claim to the `phone_number` JWT claim. |
| `local.settings.json` | Local-only secrets (gitignored). |
| `sample-payload.json` | Example Entra request body for local testing. |

## Configuration

Set these as app settings (locally in `local.settings.json`, in Azure under
**Function App → Settings → Environment variables**):

The credential is chosen automatically: if `GRAPH_CLIENT_SECRET` is present the
function uses a client secret (local/dev); otherwise it uses the Function App's
**managed identity** (Azure). Either way the identity needs the
`UserAuthenticationMethod.Read.All` Graph **application** permission, admin-consented.

| Setting | Example | Notes |
| --- | --- | --- |
| `GRAPH_TENANT_ID` | `a67366e7-…` | External tenant GUID. Required only for the client-secret (local) path. |
| `GRAPH_CLIENT_ID` | `<app id>` | App registration holding the Graph permission. Required only for the client-secret path. |
| `GRAPH_CLIENT_SECRET` | `<secret>` | **Local/dev only.** Leave unset in Azure to use the managed identity. |
| `GRAPH_MANAGED_IDENTITY_CLIENT_ID` | `<mi client id>` | Azure only, and only for a **user-assigned** managed identity. Omit for system-assigned. |
| `PHONE_CLAIM_ID` | `phoneNumber` | Claim name returned to Entra. Must match the `ID` in the claims mapping policy (case sensitive). |

> Grant the Graph app role to a managed identity via Graph/PowerShell — app-role
> assignments to managed identities aren't available in the Azure portal.

## Run locally

Requires [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local).

```bash
npm install
npm start            # runs tsc then `func start` on http://localhost:7071
```

Simulate Entra's call (set a real `user.id` in `sample-payload.json` so the Graph
call resolves):

```bash
curl -X POST http://localhost:7071/api/tokenIssuanceStart \
  -H "Content-Type: application/json" \
  --data @sample-payload.json
```

A success returns:

```json
{ "data": { "@odata.type": "microsoft.graph.onTokenIssuanceStartResponseData",
            "actions": [ { "@odata.type": "microsoft.graph.tokenIssuanceStart.provideClaimsForToken",
                           "claims": { "phoneNumber": "+1 2065551234" } } ] } }
```

## Deploy + wire into Entra

Full guides:
[custom claims provider overview](https://learn.microsoft.com/entra/identity-platform/custom-claims-provider-overview)
and [configure a custom claim provider for a token issuance event](https://learn.microsoft.com/entra/identity-platform/custom-extension-tokenissuancestart-configuration). Summary:

1. **Deploy** this function to an Azure Function App (`func azure functionapp publish <app-name>`), and set the app settings above.
2. **Grant Graph permission** — on the `GRAPH_CLIENT_ID` app registration, add the application permission `UserAuthenticationMethod.Read.All` and grant admin consent.
3. **Register the custom authentication extension** (Entra admin center → Enterprise applications → *Custom authentication extensions* → Create) with event type **`TokenIssuanceStart`**, target URL = this function's URL (including the `?code=` system key). This creates / reuses the *Azure Functions authentication events API* app registration.
4. **Protect the function** — Function App → **Authentication** → Add identity provider → Microsoft, picking the app registration from step 3 (Easy Auth validates Entra's bearer token).
5. **Assign the custom claims provider to the client app** (`react-nextjs-sample`) so claims flow into the **ID token**.
6. **Create + assign the claims mapping policy** so the returned claim is emitted. The `definition` must be a single **stringified, escaped** JSON string:

   ```bash
   # Create the policy
   POST https://graph.microsoft.com/v1.0/policies/claimsMappingPolicies
   {
     "definition": [ "{\"ClaimsMappingPolicy\":{\"Version\":1,\"IncludeBasicClaimSet\":\"true\",\"ClaimsSchema\":[{\"Source\":\"CustomClaimsProvider\",\"ID\":\"phoneNumber\",\"JwtClaimType\":\"phone_number\"}]}}" ],
     "displayName": "MfaPhoneNumberClaim",
     "isOrganizationDefault": false
   }

   # Assign it to the client app's service principal
   POST https://graph.microsoft.com/v1.0/servicePrincipals/{sp-id}/claimsMappingPolicies/$ref
   { "@odata.id": "https://graph.microsoft.com/v1.0/policies/claimsMappingPolicies/{policy-id}" }
   ```

## Notes

- This endpoint must be reachable by Entra over public HTTPS — `localhost` works only for the `curl` simulation above, not for real Entra calls.
- This adds a synchronous Graph round-trip to every token issuance. Entra caps the callout (≈2s), so keep the function warm; the handler returns no claim (rather than failing) if Graph errors or the user has no phone method.
- Returned claims are `String` / `String array` only, 3 KB total. `phone_number` is a single string here.
- **Native-auth support:** the custom claims provider is supported in native authentication (per the External ID feature-comparison table), the same as browser-delegated flows.
