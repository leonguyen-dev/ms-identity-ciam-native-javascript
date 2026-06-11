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
| `src/services/passkey-service.ts` | WebAuthn ceremony + client for the passkey proxy. |
| `passkey-proxy.mjs` | Local server that fronts the Graph `fido2Methods` APIs (keeps the client secret + app-only token out of the browser). |
| `src/components/Navbar.tsx` | Sign In / Sign Up / Reset Password / Security / Sign Out, wired to MSAL redirect. |
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

No `cors.js` / proxy is required (that was a native-auth concern). The one
exception is **passkey management**, which needs the local `passkey-proxy.mjs` —
see below.

## Passkeys (FIDO2)

Once the tenant is configured ([`entra-config/README.md` §7](./entra-config/README.md)),
**sign-in with a passkey needs no app code at all** — the Entra-hosted sign-in page
offers *"Use your face, fingerprint, PIN or security key instead"* automatically
after the user enters their email. What the app must provide is the **registration
/ management experience** (Microsoft ships no out-of-box UI yet): that's the
**Security** page (`/security`), backed by the Graph beta `fido2Methods`
provisioning APIs through `passkey-proxy.mjs`.

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
4. **Client secret**: create `.env.local` in this folder (gitignored):

   ```text
   PASSKEY_CLIENT_SECRET=<secret from entra-config §7>
   ```

### Run

```bash
npm run passkey-proxy    # terminal 1 — Graph proxy on http://localhost:3001
npm run dev:passkey      # terminal 2 — HTTPS dev server on port 3000
```

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

- Don't ship `passkey-proxy.mjs` as-is: move the same four endpoints into a real
  backend (e.g. the SWA's managed Functions) with the secret in Key Vault. The
  proxy already verifies the caller's ID token against the tenant JWKS and derives
  the Graph user id from it — keep that property.
- Registration on a deployed host requires a **custom URL domain** with the app
  served under the same registrable domain.
- Passkeys are **not** available to the native-auth sample: native auth APIs don't
  support passkeys yet (browser-delegated only).

## Deploy

Static export (`output: "export"`) → Azure Static Web Apps, same as the native-auth
sample. Add the production origin as a redirect URI on the app registration first.
See `entra-config/README.md` §7.

## Mapping to the B2C policy & known gaps

The full B2C → External ID feature mapping, and the documented fidelity gaps
(`id_token_hint` SSO, conditional TFS T&Cs, password regex, page templating,
telemetry), are in [`entra-config/README.md`](./entra-config/README.md). In short:
most flows map cleanly via the reused extension Functions; the gaps are platform
limitations of user flows vs B2C custom policies.
