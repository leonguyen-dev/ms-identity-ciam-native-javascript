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
| `src/app/security/page.tsx` | **Passkey management** — register / list / delete passkeys (FIDO2). |
| `src/services/passkey-service.ts` | WebAuthn ceremony + client for the local proxy's passkey routes. |
| `local-proxy.mjs` | Local server fronting the app-only Graph APIs behind **both** the passkey and account pages (keeps the client secret + app-only token out of the browser). Serves `/api/passkeys/*` and `/api/account/*` on one port. |
| `src/components/Navbar.tsx` | Sign In / Sign Up / Reset Password / Security / Sign Out, wired to MSAL redirect. |
| `src/app/account/page.tsx` | Signed-in self-service page: change password / sign-in email / mobile number. |
| `src/services/account-service.ts` | Client for the local proxy's account routes. |
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

No `cors.js` / proxy is required for sign-in (that was a native-auth concern).
The **passkey** and **My account** self-service pages do need the local
`local-proxy.mjs` (one server, run with `npm run proxy`) — see below.

## Passkeys (FIDO2)

Once the tenant is configured ([`entra-config/README.md` §7](./entra-config/README.md)),
**sign-in with a passkey needs no app code at all** — the Entra-hosted sign-in page
offers *"Use your face, fingerprint, PIN or security key instead"* automatically
after the user enters their email. What the app must provide is the **registration
/ management experience** (Microsoft ships no out-of-box UI yet): that's the
**Security** page (`/security`), backed by the Graph beta `fido2Methods`
provisioning APIs through `local-proxy.mjs` (`/api/passkeys/*`).

### Why the special local setup

WebAuthn only lets a page register a passkey for a relying party (`rp.id`) that
matches its own domain. Entra issues creation options with
`rp.id = myservicetasdevpoc.ciamlogin.com`, so the app must be **served from a
subdomain of that domain over HTTPS** for registration to work (sign-in is
unaffected — it happens on the hosted pages, which already live there). Locally we
fake that with a hosts-file entry + self-signed certificate, exactly like
Microsoft's upstream `passkey-sample`. In production you'd use a
[custom URL domain](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-custom-url-domain)
and host the app under it.

### One-time local setup

1. **Tenant + app registration**: complete [`entra-config/README.md` §7](./entra-config/README.md)
   (enable the FIDO2 method, grant `UserAuthMethod-Passkey.ReadWrite.All`, create a
   client secret, add the dev redirect URI).
2. **Hosts file** (as Administrator, `C:\Windows\System32\drivers\etc\hosts`):

   ```text
   127.0.0.1    auth.myservicetasdevpoc.ciamlogin.com
   ```

3. **Self-signed certificate** (Git Bash / anywhere with openssl, from this folder):

   ```bash
   mkdir -p certs
   openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
     -keyout certs/auth-key.pem -out certs/auth-cert.pem \
     -subj "//CN=auth.myservicetasdevpoc.ciamlogin.com" \
     -addext "subjectAltName=DNS:auth.myservicetasdevpoc.ciamlogin.com"
   ```

   Then trust it (PowerShell **as Administrator**):

   ```powershell
   certutil -addstore -f Root .\certs\auth-cert.pem
   ```

   (`*.pem` is gitignored.)
4. **Client secret**: create `.env.local` in this folder (gitignored). The proxy
   accepts `ACCOUNT_CLIENT_SECRET` (shared with the My account page) or, for
   back-compat, `PASSKEY_CLIENT_SECRET`:

   ```text
   ACCOUNT_CLIENT_SECRET=<secret from entra-config §7>
   ```

### Run

```bash
npm run proxy            # terminal 1 — Graph proxy on http://localhost:3001
npm run dev:passkey      # terminal 2 — HTTPS dev server on port 3000
```

(The proxy serves both the passkey and account routes, so the same
`npm run proxy` covers the My account page below — no second proxy.)

Open **`https://auth.myservicetasdevpoc.ciamlogin.com:3000`**, sign in, then go to
**Security** in the navbar:

1. **Add a passkey** → you may be bounced through MFA (the page requests a token
   with an `ngcmfa` claims challenge — Entra requires MFA completed within the last
   few minutes), then the browser's native dialog walks you through Windows Hello,
   a security key, or a phone via QR code.
2. **Sign out, then Log in** → enter your email → choose *"Use your face,
   fingerprint, PIN or security key instead"*. (This part also works from plain
   `npm run dev` on `http://localhost:3000` or from the deployed SWA, since the
   ceremony runs on the hosted page.)
3. Back on **Security** you can view and delete registered passkeys.

### Production notes

- Don't ship `local-proxy.mjs` as-is: move the same endpoints into a real
  backend (e.g. the SWA's managed Functions) with the secret in Key Vault. The
  proxy already verifies the caller's ID token against the tenant JWKS and derives
  the Graph user id from it — keep that property.
- Registration on a deployed host requires a **custom URL domain** with the app
  served under the same registrable domain.
- Passkeys are **not** available to the native-auth sample: native auth APIs don't
  support passkeys yet (browser-delegated only).
The optional **My account** page uses the same local proxy (`npm run proxy`) as
passkeys — see below.

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

Before any of that, the user must **verify the new address**. Graph has no app-only
API to send + check a code to an arbitrary email, so the proxy mints its own: the
page first calls `…/signin-name/send-otp`, which emails a 6-digit code to the new
address via Azure Communication Services (the same transport the native-auth
[`otp-email-function`](../../native-auth/otp-email-function) uses) and stores a
hash keyed by the caller's `oid`. The change endpoint then requires that code back,
so a user can only point their sign-in email at a mailbox they actually control.
Sending the code needs only a valid token; the change itself still needs fresh MFA
— the code proves *mailbox control*, the `ngcmfa` challenge proves *it's really
you*.

> **`identities` gotchas (two of them):**
> 1. Updating the `identities[]` property requires **`User.ManageIdentities.All`**
>    specifically — `User.ReadWrite.All` is *not* enough (PATCH returns **403**).
> 2. App-only `GET …?$select=identities` returns an **empty `identities[]`** for
>    External ID CIAM accounts (the property is masked), even though the email
>    identity exists. The proxy works around this by re-reading via a `$filter` on
>    `identities` (evaluated server-side, so it isn't masked) and patches on `beta`.

Because the app secret and Graph token must never reach the browser,
`local-proxy.mjs` runs locally (port 3001; `/api/account/*` routes), verifies the signed-in user's ID
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
   `User.ReadWrite.All`, `User.ManageIdentities.All` (required for the identities
   PATCH — see the gotchas above) and `UserAuthenticationMethod.ReadWrite.All`,
   and grant admin consent. Add a **client secret** (this turns the SPA's app
   registration into a confidential client for the proxy only — the browser never
   uses it).
2. Put the secret in a gitignored `.env.local` in this folder. The two
   `COMMUNICATION_SERVICES_*` values are the same ones the `otp-email-function`
   uses (an Azure Communication Services email resource with a verified sender
   domain) and are required for the sign-in-email verification code to send:
   ```bash
   ACCOUNT_CLIENT_SECRET=<the client secret value>
   COMMUNICATION_SERVICES_CONNECTION_STRING=<ACS connection string>
   COMMUNICATION_SERVICES_SENDER_ADDRESS=DoNotReply@<your-verified-domain>
   # optional, defaults to "myServiceTas"
   MAIL_SENDER_DISPLAY_NAME=myServiceTas
   ```
3. In a second terminal, start the proxy alongside `npm run dev`:
   ```bash
   npm run proxy
   ```

   (Same proxy as the Passkeys section — run it once and both pages work.)

The **My Account** entry points only show on `localhost` by default — the deployed
static export has no proxy to talk to. For production, host the same logic in an
Azure Function behind the Static Web App, keep the secret in Key Vault (or use a
managed identity), and point the SPA at it by setting `NEXT_PUBLIC_ACCOUNT_API_BASE`
at build time.

## Cross-app SSO (Feature B / B1 — the `id_token_hint` replacement)

B2C delivered cross-app SSO by minting an `id_token_hint`; External ID has **no
such mechanism**. The supported replacement for web-to-web is the **shared Entra
session** on the tenant: once the user has signed in to one web app, a second web
app on the same tenant can obtain tokens **with no prompt**. This sample proves it
by running the *same codebase twice* as two distinct relying parties.

### How it works in the code

- [`auth/SsoBootstrap.tsx`](./src/auth/SsoBootstrap.tsx) runs only when the app is
  opened as an SSO target (the peer app links here with `?sso=1` and a
  `login_hint`). It tries `ssoSilent` (hidden iframe), and on failure falls back to
  a top-level `prompt=none` `loginRedirect`.
- On **`ciamlogin.com`** the iframe path *fails by design* — the session cookie is
  third-party inside the iframe and modern browsers block it — so the
  `prompt=none` redirect (where the cookie is first-party) is what actually carries
  the session. A **single custom URL domain** across all web apps is what makes the
  iframe path work too; that's the production prerequisite (plan P0.1 / D3).
- The signed-in view ([`app/page.tsx`](./src/app/page.tsx)) shows an **Open …
  (SSO)** link when `NEXT_PUBLIC_PEER_APP_URL` is set, passing the user's email as
  `login_hint`.
- `prompt: "none"` never appears on the normal `loginRequest` (which keeps
  `prompt: "login"`); the silent paths use the dedicated `silentRequest`.

### Run two instances locally

You need a **second SPA app registration** ("App B") on the same tenant, bound to
the same user flow, with redirect URI `http://localhost:3002/`. Then run the app
twice from this folder (PowerShell — env vars are set per session because npm
scripts on Windows can't take inline `VAR=val`, and Next only auto-loads one
`.env.local`):

```powershell
# Terminal 1 — App A (original client id) on :3000, linking to App B
$env:NEXT_PUBLIC_PEER_APP_URL = "http://localhost:3002"
$env:NEXT_PUBLIC_PEER_APP_LABEL = "App B"
npm run dev    # serves http://localhost:3000

# Terminal 2 — App B (second client id) on :3002
$env:NEXT_PUBLIC_CLIENT_ID = "<APP_B_CLIENT_ID>"
$env:NEXT_PUBLIC_APP_LABEL = "App B"
$env:PORT = "3002"
$env:NEXT_DIST_DIR = ".next-appB"   # separate build dir; Next won't run two dev servers sharing one
npm run dev    # serves http://localhost:3002
```

`NEXT_DIST_DIR` is required on the second instance: Next refuses to run two dev
servers from the same project folder because they'd share the `.next/dev` lock, so
App B gets its own `.next-appB` (gitignored).

(Different ports ⇒ different origins ⇒ separate MSAL `sessionStorage` caches, so a
silent sign-in on App B proves *real* cross-app SSO, not a shared cache.)

### Try it

1. Open <http://localhost:3000> (App A) and **Log in**.
2. On the signed-in view, click **Open App B (SSO)**.
3. App B loads, runs the bootstrap, and lands you **signed in with no password /
   MFA prompt** — its claims view renders the same user. That round-trip is the
   `id_token_hint` replacement.
4. **Browser matters:** on Chrome the `prompt=none` redirect succeeds silently; on
   **Safari/iOS** the iframe path is dead (expected) but the redirect still works.
   Record the per-browser result — it's the B1.5 finding.

> Production needs the single custom URL domain (P0.1). For PlatesPlus/Power Pages,
> the same shared-session model applies via Power Pages' built-in External ID OIDC
> provider (plan B1.4) — not covered by this two-SPA spike.

## Deploy

Static export (`output: "export"`) → Azure Static Web Apps, same as the native-auth
sample. Add the production origin as a redirect URI on the app registration first.
See `entra-config/README.md` §7.
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
