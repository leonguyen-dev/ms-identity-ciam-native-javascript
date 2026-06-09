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
| `src/components/Navbar.tsx` | Sign In / Sign Up / Reset Password / Sign Out, wired to MSAL redirect. |
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

No `cors.js` / proxy is required (that was a native-auth concern).

## Deploy

Static export (`output: "export"`) → Azure Static Web Apps, same as the native-auth
sample. Add the production origin as a redirect URI on the app registration first.
See `entra-config/README.md` §6.

## Mapping to the B2C policy & known gaps

The full B2C → External ID feature mapping, and the documented fidelity gaps
(`id_token_hint` SSO, conditional TFS T&Cs, password regex, page templating,
telemetry), are in [`entra-config/README.md`](./entra-config/README.md). In short:
most flows map cleanly via the reused extension Functions; the gaps are platform
limitations of user flows vs B2C custom policies.
