# Attribute Submit Function (Entra External ID → ServiceTas portal / TFS)

A TypeScript Azure Function (v4 programming model) that implements the Entra
External ID **`OnAttributeCollectionSubmit`** custom authentication extension. After a
user fills in the sign-up attributes, Entra calls this function, which:

1. **Validates the email** against the ServiceTas portal — a mock of `POST /Portal/checkAccess`.
   A blocked email returns **`showBlockPage`**, stopping the sign-up with a full-page
   message. (Not `showValidationError`: the email is a verified identity, not a
   collected attribute, so an error keyed to it is silently dropped by native auth and
   rejected by the hosted user flow.)
2. **Registers the user in TFS** — a mock of `POST /B2CPortal/createSignUp`.
3. Returns **`continueWithDefaultBehavior`** so Entra completes the sign-up.

> The two backend calls are mocked in `src/mockBackend.ts` for the POC. They keep
> the same shape they will have once swapped for real HTTPS calls, so the handler
> doesn't change.

## How it works

```text
user submits sign-up attributes  →  Entra raises OnAttributeCollectionSubmit
        │
        ▼
Entra POSTs { userSignUpInfo: { attributes, identities }, ... }  →  this function
        │
        ├─ checkAccess(email)  (mock /Portal/checkAccess)
        │     └─ blocked? → showBlockPage (full-page message, sign-up stopped)
        │
        ├─ createSignUp(...)   (mock /B2CPortal/createSignUp → TFS)
        │     └─ backend error? → showBlockPage
        │
        ▼
returns continueWithDefaultBehavior  →  Entra finishes the sign-up
```

## Project layout

| File | Purpose |
| --- | --- |
| `src/functions/attributeCollectionSubmit.ts` | HTTP-triggered handler; parses the Entra payload, runs the two backend steps, returns the matching action. |
| `src/mockBackend.ts` | Mock `checkAccess` / `createSignUp`. Swap the bodies for real `fetch` calls in production. |
| `local.settings.json` | Local-only settings (gitignored) — the mock block lists. |
| `sample-payload.json` | Example Entra request body for local testing. |

## Configuration

Set these as app settings (locally in `local.settings.json`, in Azure under
**Function App → Settings → Environment variables**):

| Setting | Example | Notes |
| --- | --- | --- |
| `BLOCKED_EMAILS` | `blocked@example.com,denied@example.com` | Comma-separated; the mock `checkAccess` denies these exact addresses. |
| `BLOCKED_DOMAINS` | `blocked.example.com,mailinator.com` | Comma-separated; the mock `checkAccess` denies these domains. |

## Run locally

Requires [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local).

```bash
npm install
npm start            # runs tsc then `func start` on http://localhost:7071
```

Simulate Entra's call (the `func start` output prints the exact URL + key):

```bash
# Success → continueWithDefaultBehavior (someone@example.com is allowed)
curl -X POST http://localhost:7071/api/attributeCollectionSubmit \
  -H "Content-Type: application/json" \
  --data @sample-payload.json
```

A success returns:

```json
{ "data": { "@odata.type": "microsoft.graph.onAttributeCollectionSubmitResponseData",
            "actions": [ { "@odata.type": "microsoft.graph.attributeCollectionSubmit.continueWithDefaultBehavior" } ] } }
```

To see the **blocked** path, edit `issuerAssignedId` in `sample-payload.json` to one
of the `BLOCKED_EMAILS` (e.g. `blocked@example.com`) and POST again — the response
becomes a `showBlockPage`:

```json
{ "data": { "@odata.type": "microsoft.graph.onAttributeCollectionSubmitResponseData",
            "actions": [ { "@odata.type": "microsoft.graph.attributeCollectionSubmit.showBlockPage",
                           "title": "Registration blocked", "message": "..." } ] } }
```

## Deploy + wire into Entra

Scripted end-to-end in [`deploy/`](deploy/) — see [`deploy/README.md`](deploy/README.md):

1. **`deploy/1-provision-and-deploy.ps1`** — provisions a new Azure Function App, sets the app settings above, publishes the code, and prints the Target URL (with `?code=` key).
2. **Protect the function** with Easy Auth, reusing the same "authentication events API" app registration as `otp-email-function` (portal step; details in the deploy README).
3. **`deploy/2-register-extension.ps1`** — creates the `OnAttributeCollectionSubmit` custom extension via Microsoft Graph (reusing the OTP extension's `resourceId`, so no new consent) and attaches it to your sign-up user flow.

Reference: [Add attribute collection custom extensions to your user flow](https://learn.microsoft.com/entra/identity-platform/custom-extension-attribute-collection).

## Notes

- This endpoint must be reachable by Entra over public HTTPS — `localhost` works only for the `curl` simulation above, not for real Entra calls.
- Entra caps this callout at a few seconds; the real `checkAccess` / `createSignUp` calls should be fast and time-bounded to avoid `CustomExtensionTimedOut`.
- The password is never sent in this payload; only collected attributes and verified identities are.
