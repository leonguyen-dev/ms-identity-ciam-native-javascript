# attribute-start-function

Entra External ID **OnAttributeCollectionStart** custom authentication extension. It
runs at the start of the sign-up attribute-collection step (after the user's email is
verified by OTP, before the details page) and **blocks sign-up** for any email on a
configurable blocklist, otherwise letting the flow continue.

This is the authoritative, server-side counterpart to the React client's blocklist in
[`react-nextjs-sample/src/app/shared/utils/emailBlocklist.ts`](../react-nextjs-sample/src/app/shared/utils/emailBlocklist.ts).
The client check is UX only — it stops a blocked email before any OTP is sent — and is
bypassable by calling the native-auth API directly. This function can't be bypassed.
**Keep the two lists in sync.**

> Entra has no extension point _before_ the email OTP, so this is the earliest a
> server-side check can block by email. A blocked email reaching this function has
> already verified its address; the client-side check is what spares blocked users the
> OTP round-trip.

## How it works

Entra POSTs the verified email as an `email` identity in
`data.userSignUpInfo.identities[]`. The handler
([`src/functions/attributeCollectionStart.ts`](src/functions/attributeCollectionStart.ts)):

1. Extracts the email identity (no email → continue, don't hold up sign-up).
2. Checks it against `BLOCKED_EMAILS` / `BLOCKED_DOMAINS`
   ([`src/emailBlocklist.ts`](src/emailBlocklist.ts)).
3. Returns `showBlockPage` (blocked) or `continueWithDefaultBehavior` (allowed).

Response schema: [OnAttributeCollectionStart REST API](https://learn.microsoft.com/entra/identity-platform/custom-extension-onattributecollectionstart-retrieve-return-data).

## Configuration (app settings)

| Setting           | Example                                | Notes                                            |
| ----------------- | -------------------------------------- | ------------------------------------------------ |
| `BLOCKED_EMAILS`  | `someone@example.com,blocked@acme.com` | Exact addresses, comma-separated, case-insensitive. |
| `BLOCKED_DOMAINS` | `mailinator.com,tempmail.io`           | Domains; also matches subdomains.                |

Locally these live in `local.settings.json` (git-ignored); in Azure they're Function App
application settings (set by the deploy script).

## Run locally

```powershell
npm install
npm start            # builds (tsc) then `func start`
```

Then POST the sample payload (which uses a blocked email) to the local endpoint:

```powershell
$body = Get-Content sample-payload.json -Raw
Invoke-RestMethod -Method Post -Uri "http://localhost:7071/api/attributeCollectionStart" `
  -ContentType "application/json" -Body $body
```

With the default `local.settings.json`, `someone@example.com` returns a `showBlockPage`
action; change the email in the payload to a non-blocked address to get
`continueWithDefaultBehavior`.

## Deploy + wire into Entra

See [`deploy/README.md`](deploy/README.md): provision the Function App, protect it with
Easy Auth (mirroring the OTP function), then register the extension and attach it to your
sign-up user flow's **Before collecting information** step.
