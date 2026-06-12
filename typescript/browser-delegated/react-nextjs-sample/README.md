# Service Tasmania — Browser-Delegated POC (Microsoft Entra External ID)

A proof of concept of the Service Tasmania sign-up / sign-in / reset-password flows
on **Microsoft Entra External ID** using the **browser-delegated (redirect)**
approach with MSAL. It is the External ID counterpart to the Azure AD B2C custom
policy `B2C_1A_ServiceTas_SignUp_SignIn`.

This sample is a **sibling** of the native-auth sample (`../../native-auth/react-nextjs-sample`).
The key difference: here the sign-up/sign-in/reset UI lives on **Entra-hosted
user-flow pages**, and MSAL only starts the redirect and reads the resulting
tokens. That is *closer to B2C* (which also hosted its pages) than the native-auth
sample, and it means **there is no CORS proxy** — the browser redirects straight to
`ciamlogin.com`.

## How it works

```
React SPA  ──loginRedirect()──▶  Entra-hosted user flow (ServiceTas_SignUpSignIn)
                                   │  sign in / sign up / forgot password
                                   │  email OTP  (OnOtpSend → otp-email-function)
                                   │  attribute collection
                                   │     ├─ OnAttributeCollectionStart  (attribute-start-function: email blocklist)
                                   │     └─ OnAttributeCollectionSubmit  (attribute-submit-function: validation + TFS provisioning)
                                   │  MFA (SMS / Email OTP, enforced by Conditional Access)
                                   │  OnTokenIssuanceStart (token-issuance-function: phone_number claim)
                                   ▼
React SPA  ◀──redirect back──  tokens in sessionStorage → claims view
```

## What's in here

| Path | Purpose |
|---|---|
| `src/config/auth-config.ts` | MSAL `PublicClientApplication` config (authority, redirect URI, scopes). **Set `clientId`.** |
| `src/auth/AuthProvider.tsx` | Initializes MSAL and wraps the app in `MsalProvider`. |
| `src/app/page.tsx` | Branded home: sign-in/sign-up triggers when signed out; ID-token claims view when signed in. |
| `src/app/reset-password/page.tsx` | Routes the user into the hosted flow's *Forgot password?* (SSPR). |
| `src/app/account/page.tsx` | Signed-in self-service page: change password / sign-in email / mobile number. |
| `src/services/account-service.ts` | Client for the account proxy. |
| `account-proxy.mjs` | Local app-only Graph proxy backing the account page (holds the client secret). |
| `src/components/Navbar.tsx` | Sign In / Sign Up / Reset Password / My Account / Sign Out, wired to MSAL redirect. |
| `entra-config/README.md` | **All the Entra portal + Graph setup** (user flow, custom attributes, extensions, CA/MFA, app registration, deployment). |
| `entra-config/custom-ui.css` | Service Tasmania custom CSS for the hosted user-flow pages. |

## Run locally

1. Complete the tenant setup in [`entra-config/README.md`](./entra-config/README.md)
   (at minimum: a user flow + an SPA app registration with redirect URI
   `http://localhost:3000/`).
2. Put the SPA app's client id in `src/config/auth-config.ts`.
3. Install and start:
   ```bash
   npm install
   npm run dev
   ```
4. Open http://localhost:3000 and select **Log in** or **Create an account**. You're
   redirected to the hosted Service Tasmania pages and returned signed in; the home
   page then shows the decoded ID-token claims (including the custom `phone_number`).

No `cors.js` / proxy is required for sign-in (that was a native-auth concern). The
optional **My account** page does need a small local proxy — see below.

## My account (change password / sign-in name / phone)

Once signed in, the **My Account** page (`/account`) lets the user change their
password, the email they sign in with, and their MFA mobile number.

**Change password** routes into the Entra-hosted self-service password reset
("Forgot password?") flow — *not* Graph. Microsoft Graph's `resetPassword` API
**does not support application permissions** (and can't act on a user's own
account), and External ID exposes no delegated self-service password permission for
customers, so hosted SSPR is the only supported path.

The other two map to a Microsoft Graph API that only accepts an **app-only token**
(there is no delegated/self-service Graph permission for external-tenant customers):

| Action | Graph call | App permission |
|---|---|---|
| Read summary | `GET /users/{id}` + `…/authentication/phoneMethods` | `User.Read.All` |
| Change sign-in name (identity) | `PATCH /beta/users/{id}` (replace `identities[]`) | `User.ManageIdentities.All` |
| …also sync email OTP method | `PATCH /users/{id}/authentication/emailMethods/{id}` | `UserAuthenticationMethod.ReadWrite.All` |
| …also sync profile email | `PATCH /users/{id}` (`mail`, `otherMails`) | `User-Mail.ReadWrite.All` (or `User.ReadWrite.All`) |
| Change phone number | `PATCH`/`POST /users/{id}/authentication/phoneMethods` | `UserAuthenticationMethod.ReadWrite.All` |

Changing the sign-in name fans the new email out to **everywhere relevant**: the
sign-in identity (primary), the email one-time-passcode method, and the `mail`/
`otherMails` profile fields (which drive the token's email claim). The identity
change is required; the other two are best-effort and the proxy reports which ones
synced. The literal `userPrincipalName` is intentionally left as the tenant's
`…onmicrosoft.com` GUID — it can't be an unverified-domain email, so the email a
user sees in the token comes from the identity / `mail`, not the UPN. Users must
**sign out and back in** to get a token reflecting the new email.

> **`identities` gotchas (two of them):**
> 1. Updating the `identities[]` property requires **`User.ManageIdentities.All`**
>    specifically — `User.ReadWrite.All` is *not* enough (PATCH returns **403**).
> 2. App-only `GET …?$select=identities` returns an **empty `identities[]`** for
>    External ID CIAM accounts (the property is masked), even though the email
>    identity exists. The proxy works around this by re-reading via a `$filter` on
>    `identities` (evaluated server-side, so it isn't masked) and patches on `beta`.

Because the app secret and Graph token must never reach the browser,
`account-proxy.mjs` runs locally (port 3001), verifies the signed-in user's ID
token (signature/issuer/audience/tenant/expiry) against the tenant JWKS, derives
the Graph user id from its `oid`, and only then calls Graph. Every mutation also
requires a **fresh-MFA** token (the SPA requests it with an `ngcmfa` claims
challenge and redirects for MFA if it isn't recent), so a user can only ever change
*their own* account and only just after proving their identity.

> **Note on "change password":** Graph's only password path is the *admin* reset
> API, so after a change Entra prompts the user to set a new password at their next
> sign-in. The page tells the user this.

**To run it:**

1. On the SPA app registration, add the **application** Graph permissions
   `User.ReadWrite.All` and `UserAuthenticationMethod.ReadWrite.All` and grant
   admin consent. Add a **client secret** (this turns the SPA's app registration
   into a confidential client for the proxy only — the browser never uses it).
2. Put the secret in a gitignored `.env.local` in this folder:
   ```bash
   ACCOUNT_CLIENT_SECRET=<the client secret value>
   ```
3. In a second terminal, start the proxy alongside `npm run dev`:
   ```bash
   npm run account-proxy
   ```

For production, host the same logic in an Azure Function behind the Static Web App
and keep the secret in Key Vault (or use a managed identity).

## Deploy

Static export (`output: "export"`) → Azure Static Web Apps, same as the native-auth
sample. Unlike native-auth there is **no managed API function** — browser-delegated
redirects go straight to `ciamlogin.com`, so there is no `--api-location`.

Put the SWA deployment token in a gitignored `.env` as `SWA_CLI_DEPLOYMENT_TOKEN`,
then from this folder:

```bash
# 1. Build the static export → out/  (staticwebapp.config.json is copied in automatically)
npm run build

# 2. Deploy out/ to the production environment
#    (the SWA CLI reads SWA_CLI_DEPLOYMENT_TOKEN from .env)
swa deploy ./out --env production --deployment-token "$SWA_CLI_DEPLOYMENT_TOKEN"
```

Production URL: <https://ambitious-glacier-0f4083000.7.azurestaticapps.net>

**Before testing prod:** add the production origin as a redirect URI on the SPA app
registration in Entra, or MSAL redirects fail:

```text
https://ambitious-glacier-0f4083000.7.azurestaticapps.net/
```

(SPA platform, trailing slash to match `trailingSlash: true`.) See
`entra-config/README.md` §6.

## Mapping to the B2C policy & known gaps

The full B2C → External ID feature mapping, and the documented fidelity gaps
(`id_token_hint` SSO, conditional TFS T&Cs, password regex, page templating,
telemetry), are in [`entra-config/README.md`](./entra-config/README.md). In short:
most flows map cleanly via the reused extension Functions; the gaps are platform
limitations of user flows vs B2C custom policies.
