# Wiring attribute-submit-function into Entra

This function is an Entra External ID **OnAttributeCollectionSubmit** custom extension.
When a user submits the sign-up page, Entra POSTs the collected attributes and the
function:

1. **validates `dateOfBirth`** — it must be a real calendar date in `DD/MM/YYYY` form
   for someone at least **16** years old. A failure returns a `showValidationError`
   keyed to the attribute, so the hosted page re-prompts the user inline.
2. **composes `displayName`** from the collected `givenName` and `surname` and returns
   `modifyAttributeValues` so Entra persists it. (`displayName` must be one of the
   attributes collected by the user flow, otherwise the modify is ignored.)
3. otherwise returns `continueWithDefaultBehavior` so Entra completes the sign-up.

Three steps to wire it up: **deploy** the function → **protect** it with Easy Auth →
**register** the custom extension and attach it to your sign-up user flow. Steps 1 and 3
are scripted; step 2 is a short portal action because it must mirror the
identity-provider config already on the OTP function app.

Prerequisites:

```powershell
# Azure CLI + Functions Core Tools v4 (for step 1)
az login
# Microsoft.Graph PowerShell SDK (for step 3)
Install-Module Microsoft.Graph -Scope CurrentUser
```

## Step 1 — Provision the Function App + deploy

Edit the parameters at the top of [`1-provision-and-deploy.ps1`](1-provision-and-deploy.ps1)
(`FunctionApp` and `StorageAccount` must be globally unique; copy your existing
`ResourceGroup`/`Location` with `az functionapp list -o table`), then:

```powershell
cd typescript/native-auth/attribute-submit-function/deploy
./1-provision-and-deploy.ps1
```

It creates the app, publishes the code, and prints the **Target URL** (including the
`?code=` host key) you'll pass to step 3.

## Step 2 — Protect the function with Easy Auth (mirror the OTP app)

The custom extension authenticates to the function with an Entra **bearer token**, so
the new Function App must validate that token — exactly as the OTP function app does.
Reuse the **same** "Azure Functions authentication events API" app registration:

**Portal (reliable path):** Function App → **Settings → Authentication** → **Add identity
provider** → **Microsoft** → **Pick an existing app registration in this directory** →
select the same app the OTP function uses → set **Unauthenticated requests** to
**HTTP 401** → Add.

> To confirm which app the OTP function uses (so you pick the same one):
>
> ```powershell
> az webapp auth show -n <otp-function-app> -g <resource-group> `
>   --query "identityProviders.azureActiveDirectory.registration.clientId" -o tsv
> ```

Because step 3 reuses that app's `resourceId` as the token audience, no new app
registration or admin consent is required — the consent granted for the OTP extension
already covers this one.

## Step 3 — Register the extension + attach to the user flow

Pass the Target URL from step 1:

```powershell
./2-register-extension.ps1 -TargetUrl "https://<app>.azurewebsites.net/api/attributeCollectionSubmit?code=<key>"
```

It discovers the OTP extension's `resourceId` automatically, creates the
`onAttributeCollectionSubmitCustomExtension`, lists your sign-up user flows for you to
pick one, and PATCHes that flow's `onAttributeCollectionSubmit` handler to point at the
new extension.

To target a specific flow non-interactively, pass `-FlowId <id>` (and `-ResourceId` to
override the discovered value).

> Make sure your sign-up user flow **collects** `dateOfBirth`, `givenName`, `surname`,
> and `displayName`. The function reads the first three and writes `displayName`; Entra
> ignores a `modifyAttributeValues` for any attribute the flow doesn't collect.

## Verify

- Entra admin center → **External Identities → User flows → _your flow_ → Custom
  authentication extensions** — the submit step should list this extension.
- Run a sign-up. Watch live results under **Enterprise applications → Sign-in logs →
  Authentication Events**. Then check the two behaviors:
  - **Date of birth** — an under-16 date, a malformed value (not `DD/MM/YYYY`), or an
    impossible date (e.g. `31/02/2020`) should re-prompt the field inline and block the
    submit. A valid date for someone 16+ should pass.
  - **displayName** — after a successful sign-up, the new user's `displayName` should be
    `givenName surname` (e.g. "Ada Lovelace"), composed by the function rather than
    whatever the user typed.

## Troubleshooting

- `AADSTS1100001` underlying `1003011 CustomExtensionNotFound` → the flow points at a
  deleted/wrong extension id. Re-run step 3 or fix the handler.
- `1003005` invalid token / `401` from the function → Easy Auth audience (step 2)
  doesn't match the extension's `resourceId`. Re-pick the same app as the OTP function.
- `1003002/1003003` → the function was reached but returned a bad status/body; check
  the Function App logs and the response shape in
  [`attributeCollectionSubmit.ts`](../src/functions/attributeCollectionSubmit.ts).
- Date-of-birth error never fires, or `displayName` isn't applied → confirm the user
  flow actually collects those attributes. Custom attributes arrive prefixed
  (`extension_<appid>_dateOfBirth`); the function matches `dateOfBirth` by suffix, but
  `givenName`/`surname`/`displayName` must be the built-in attributes.
