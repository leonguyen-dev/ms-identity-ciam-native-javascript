# OTP Email Function (Entra External ID → Azure Communication Services)

A TypeScript Azure Function (v4 programming model) that implements the Entra
External ID **`OnOtpSend`** custom authentication extension. When a user triggers an
email one-time-passcode, Entra calls this function with the email + code, and the
function sends a **Service Tasmania-branded** email via Azure Communication Services.

> One handler covers **all** Email-OTP flows — sign-up verification, sign-in OTP,
> password reset, and email MFA — because they all raise the same `OnOtpSend` event.
> No change to the `react-nextjs-sample` client is required.

## How it works

```text
signUp / signIn / resetPassword  →  Entra generates OTP
        │
        ▼
Entra POSTs { otpContext: { identifier, oneTimeCode }, ... }  →  this function
        │
        ▼
function sends branded email via ACS  →  returns continueWithDefaultBehavior
        │
        ▼
Entra validates the code the user types against the same OTP
```

## Project layout

| File | Purpose |
| --- | --- |
| `src/functions/emailOtpSend.ts` | HTTP-triggered handler; parses the Entra payload, sends via ACS, returns the continue action. |
| `src/emailTemplate.ts` | Branded HTML/plain-text email (green banner, "Your code is", Service Tasmania footer). |
| `local.settings.json` | Local-only secrets (gitignored). |
| `sample-payload.json` | Example Entra request body for local testing. |

## Configuration

Set these as app settings (locally in `local.settings.json`, in Azure under
**Function App → Settings → Environment variables**):

| Setting | Example | Notes |
| --- | --- | --- |
| `COMMUNICATION_SERVICES_CONNECTION_STRING` | `endpoint=https://<acs>.communication.azure.com/;accesskey=…` | From ACS → Keys. |
| `COMMUNICATION_SERVICES_SENDER_ADDRESS` | `DoNotReply@<id>.azurecomm.net` | A verified MailFrom address on your ACS Email domain. |
| `MAIL_SENDER_DISPLAY_NAME` | `myServiceTas` | Optional; greeting/signature name. The actual "From" display name is set on the ACS domain's MailFrom. |

## Run locally

Requires [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local).

```bash
npm install
npm start            # runs tsc then `func start` on http://localhost:7071
```

Simulate Entra's call (the `func start` output prints the exact URL + key):

```bash
curl -X POST http://localhost:7071/api/emailOtpSend \
  -H "Content-Type: application/json" \
  --data @sample-payload.json
```

A success returns:

```json
{ "data": { "@odata.type": "microsoft.graph.OnOtpSendResponseData",
            "actions": [ { "@odata.type": "microsoft.graph.OtpSend.continueWithDefaultBehavior" } ] } }
```

…and the recipient in `sample-payload.json` receives the branded email.

## Deploy + wire into Entra

Full guide: [Configure a custom email provider for OTP send events](https://learn.microsoft.com/entra/identity-platform/custom-extension-email-otp-get-started). Summary:

1. **Deploy** this function to an Azure Function App (`func azure functionapp publish <app-name>`), and set the three app settings above.
2. **Register the custom authentication extension** (Entra admin center → Enterprise applications → *Custom authentication extensions* → Create) with event type **`EmailOtpSend`**, target URL = this function's URL (including the `?code=` system key), and create the *Azure Functions authentication events API* app registration.
3. **Protect the function** — in the Function App → **Authentication** → Add identity provider → Microsoft, picking the app registration from step 2 (Easy Auth validates Entra's bearer token).
4. **Enable the provider** for your user flow / tenant.
5. *(Optional)* **Fallback to Microsoft** if the function errors — `PATCH` the
   `authenticationEventListener` with `fallbackToMicrosoftProviderOnError` (see the guide's Step 7).

## Notes

- This endpoint must be reachable by Entra over public HTTPS — `localhost` works only for the `curl` simulation above, not for real Entra calls.
- The OTP is generated and validated by Entra; this function only delivers it. Never log `oneTimeCode`.
