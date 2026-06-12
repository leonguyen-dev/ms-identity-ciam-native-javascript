# Native Authentication Demo

---

## 1. Overview

This POC proves that we can run a **fully custom-branded sign-up / sign-in / password-reset experience entirely inside our own web app** — no redirect to a Microsoft-hosted login page — while still using Microsoft Entra External ID as the identity backend. We own the UI, the branding, the verification emails, and the token contents. Three moving parts:

| # | Component | What it is | Where it runs |
| --- | --- | --- | --- |
| 1 | **React / Next.js SPA** | The branded customer-facing app (sign-up, sign-in, reset, MFA) using MSAL **native auth** | Azure Static Web Apps (SWA) |
| 2 | **OnOtpSend function** (`otp-email-function`) | Sends our own branded OTP verification emails + enforces an email blocklist | Azure Function |
| 3 | **OnTokenIssuanceStart function** (`token-issuance-function`) | Injects the user's MFA phone number into the ID token as a custom claim | Azure Function |

Components 2 and 3 are **Entra "custom authentication extensions"** — webhooks Entra calls *during* the auth pipeline. They are the key story: they let us customise behaviour that the portal alone cannot.

---

## 2. Architecture at a glance

```text
                    ┌─────────────────────────────┐
   Customer browser │  React/Next.js SPA (SWA)     │
                    │  @azure/msal-browser         │
                    │  /custom-auth                │
                    └───────────┬─────────────────┘
                                │ native-auth REST calls
                                │ (proxied — see §3.4)
                                ▼
                    ┌─────────────────────────────┐
                    │  /api  (SWA managed function)│  ← CORS proxy + attribute validation
                    └───────────┬─────────────────┘
                                ▼
                    ┌─────────────────────────────┐
                    │  Entra External ID (CIAM)    │
                    │  tenant: myservicetasdevpoc  │
                    └───┬──────────────────────┬───┘
                        │ OnOtpSend            │ OnTokenIssuanceStart
                        ▼                      ▼
            ┌────────────────────┐   ┌──────────────────────────┐
            │ otp-email-function │   │ token-issuance-function  │
            │  → ACS email +     │   │  → MS Graph phoneMethods │
            │    blocklist       │   │  → custom claim in token │
            └────────────────────┘   └──────────────────────────┘
```

**Tenant / app identifiers (consistent across all components):**

- Tenant subdomain: `myservicetasdevpoc` → authority `https://myservicetasdevpoc.ciamlogin.com/...`
- Tenant ID: `a67366e7-9873-4a38-9bae-0a4a18952688`
- SPA App (client) ID: `5f0a52ca-f5db-4a6d-9b3a-3180d51fdd08`

Defined in [auth-config.ts](typescript/native-auth/react-nextjs-sample/src/config/auth-config.ts) and mirrored in [proxy.config.js](typescript/native-auth/react-nextjs-sample/proxy.config.js).

---

## 3. Component 1 — React / Next.js SPA (the static web app)

Location: [typescript/native-auth/react-nextjs-sample/](typescript/native-auth/react-nextjs-sample/)

### 3.1 Stack

- **Next.js 16 + React 19 + TypeScript**, App Router.
- **MSAL:** `@azure/msal-browser` v4.30+, using its **`/custom-auth`** module (`CustomAuthPublicClientApplication`). Initialised in [AuthClientProvider.tsx](typescript/native-auth/react-nextjs-sample/src/auth/AuthClientProvider.tsx).
- **Static export** (`output: "export"` in [next.config.ts](typescript/native-auth/react-nextjs-sample/next.config.ts)) → pure static HTML/JS, hostable on SWA with no Node server.

### 3.2 What "native authentication" means here (the headline)

Traditional Entra sign-in **redirects** the user to a Microsoft-hosted page. **Native auth keeps the user in our app** — every step (email entry, OTP, password, MFA) is our own React UI calling Entra's native-auth REST API directly. This is what makes the Service Tasmania branding fully ours end-to-end.

Configured capabilities in [auth-config.ts](typescript/native-auth/react-nextjs-sample/src/config/auth-config.ts):

- `challengeTypes: ["password", "oob", "redirect"]` — password, one-time-passcode ("oob" = out-of-band), and redirect fallback.
- `capabilities: ["mfa_required", "registration_required"]` — supports enforced MFA and just-in-time auth-method registration.
- Tokens cached in `sessionStorage` (cleared when the tab closes; no persistent cookie).

### 3.3 The three flows (what you'll demo)

**Sign-up** — [sign-up/page.tsx](typescript/native-auth/react-nextjs-sample/src/app/sign-up/page.tsx)

1. Enter email → client-side blocklist check ([emailBlocklist.ts](typescript/native-auth/react-nextjs-sample/src/app/shared/utils/emailBlocklist.ts)) → `authClient.signUp()`.
2. Email OTP verification (the email is sent by **Component 2**, branded).
3. Attribute collection — `givenName`, `surname`, `dateOfBirth`, `termsAccepted` — **validated server-side** (see §3.5) before submission.
4. Password set (if password flow).
5. JIT registration of a phone number for MFA (+61 default).
6. Automatic sign-in after successful registration.

**Sign-in** — [page.tsx](typescript/native-auth/react-nextjs-sample/src/app/page.tsx)

1. Email → choose password or passwordless (email OTP).
2. MFA challenge (SMS) if required.
3. JIT auth-method registration if the user has no strong method yet.
4. On success, the app displays the decoded ID-token claims in a table — **this is where the MFA phone-number claim from Component 3 will be visible.**

**Self-service password reset** — [reset-password/page.tsx](typescript/native-auth/react-nextjs-sample/src/app/reset-password/page.tsx): email → OTP → new password → auto sign-in (+ MFA if enforced).

### 3.4 Why there's a CORS proxy (important — explains the `/api` layer)

Entra's **native-auth REST endpoints do not return CORS headers**, so a browser SPA cannot call them directly ([documented Microsoft limitation](https://learn.microsoft.com/entra/identity-platform/reference-native-authentication-api)). A same-origin proxy is required:

- **Local dev:** [cors.js](typescript/native-auth/react-nextjs-sample/cors.js) — Node server on port 3001.
- **Production (SWA):** [api/src/functions/authProxy.ts](typescript/native-auth/react-nextjs-sample/api/src/functions/authProxy.ts) — an SWA managed Azure Function that forwards `/api/*` to `https://myservicetasdevpoc.ciamlogin.com/...`. The SPA auto-resolves which proxy URL to use based on the hostname.

### 3.5 Server-side attribute validation (a deliberate design decision)

Native auth **does not fire** the `OnAttributeCollectionStart` / `OnAttributeCollectionSubmit` extensions (those only fire in the *browser* user-flow). So sign-up attribute rules (age 16–120, name length/character rules, T&C acceptance) are enforced via **our own `/api/validate-attributes` endpoint** instead, called immediately before `submitAttributes()`.

- Rules live in [api/src/attributeValidation.ts](typescript/native-auth/react-nextjs-sample/api/src/attributeValidation.ts), mirrored into the dev proxy [cors.js](typescript/native-auth/react-nextjs-sample/cors.js).
- The client fetch **fails closed** — if the validation endpoint is unreachable, sign-up is blocked rather than allowed through.

### 3.6 Branding (Service Tasmania)

- Colours/tokens in [globals.css](typescript/native-auth/react-nextjs-sample/src/app/globals.css): primary green `#267151`, hero green `#098851`, light-grey page background `#f5f5f5`.
- **Nunito** font (Google Fonts), loaded in [layout.tsx](typescript/native-auth/react-nextjs-sample/src/app/layout.tsx).
- Sharp-cornered inputs/buttons in [authFlowStyles.ts](typescript/native-auth/react-nextjs-sample/src/app/shared/styles/authFlowStyles.ts).
- Dual logos (Tasmanian Government emblem + Service Tasmania wordmark) in the [Navbar](typescript/native-auth/react-nextjs-sample/src/components/Navbar.tsx).

### 3.7 Friendly error handling

Raw `AADSTS…` error codes are never shown to users — they are mapped to plain-English messages in [friendlyAuthError.ts](typescript/native-auth/react-nextjs-sample/src/app/shared/utils/friendlyAuthError.ts) (wrong password, locked account, expired code, expired session, etc.), and trace IDs are scrubbed. Password-policy failures get their own friendly text in [passwordValidation.ts](typescript/native-auth/react-nextjs-sample/src/app/shared/utils/passwordValidation.ts).

### 3.8 Deployment (SWA)

- SPA static export + the `/api` Azure Functions deploy together to **Azure Static Web Apps**.
- SPA routing handled by [public/staticwebapp.config.json](typescript/native-auth/react-nextjs-sample/public/staticwebapp.config.json) (navigation fallback to `/index.html`).
- Production tenant values can be overridden via env vars `CIAM_TENANT_SUBDOMAIN` / `CIAM_TENANT_ID` on the SWA function; otherwise they fall back to the hardcoded dev tenant.

---

## 4. Component 2 — OnOtpSend extension (`otp-email-function`)

Location: [typescript/native-auth/otp-email-function/](typescript/native-auth/otp-email-function/)
Main file: [src/functions/emailOtpSend.ts](typescript/native-auth/otp-email-function/src/functions/emailOtpSend.ts)

### 4.1 What it does

Entra generates the one-time passcode itself, then **calls this function with the user's email + that code**. The function sends a **branded email via Azure Communication Services (ACS)** and tells Entra "continue" — Entra then validates whatever code the user types against its own copy. We are *not* generating or validating codes; we are only responsible for **delivering a nicely branded email**.

> **One function covers every email-OTP moment:** sign-up verification, sign-in OTP, password-reset, and email-based MFA all raise the same `OnOtpSend` event.

### 4.2 Branded email

- Service Tasmania green banner (`#098851`), "Service Tasmania / TASMANIAN GOVERNMENT" footer, Nunito-with-fallback font, table-based inline-styled HTML for email-client compatibility. Both HTML and plain-text versions produced. Template: [src/emailTemplate.ts](typescript/native-auth/otp-email-function/src/emailTemplate.ts). Subject: *"myServiceTas account email verification code"*.
- **Performance note worth mentioning:** Entra caps this callout at **~2 seconds**. The code uses ACS `beginSend()` and returns immediately (it does **not** wait for final delivery), so it never trips Entra's timeout (`CustomExtensionTimedOut`).

### 4.3 Email blocklist — the security feature (⚠️ note the recent change)

The function enforces an **email/domain blocklist** ([src/emailBlocklist.ts](typescript/native-auth/otp-email-function/src/emailBlocklist.ts)) before sending. Lists come from app settings `BLOCKED_EMAILS` and `BLOCKED_DOMAINS` (comma-separated, case-insensitive; domain entries also match subdomains).

**Why this matters for native auth:** Entra never fires `OnAttributeCollectionStart` in native flows, so `OnOtpSend` is the **earliest server-side point** at which we can stop a blocked address — *before any code is even sent*.

**Current behaviour (per the committed source today):**

- A blocked email → function returns **HTTP 403** with the friendly reason and **does not send the OTP**, which fails the callout.
- **It blocks on *any* OTP flow, not just sign-up.** The code was originally scoped to `requestType === "signUp"`, but native auth sends a different/empty `requestType`, so that guard let blocked sign-ups slip through. It now blocks blocklisted addresses across sign-in / reset / MFA too — which is the intended "banned address" behaviour. `requestType` is logged on every call for visibility. (See the comment block at the top of [emailOtpSend.ts](typescript/native-auth/otp-email-function/src/functions/emailOtpSend.ts).)
- `OnOtpSend` has **no `showBlockPage` action**, so the friendly message the user sees is rendered by the React client's own pre-`signUp()` check, not by Entra.

> The same blocklist logic is intentionally **duplicated in three places** that must stay in sync: this function, the `attribute-start-function` (browser-flow guard), and the React client (instant UX). They're separate Node projects with no shared package.

### 4.4 Contracts, security, config

- **Inbound payload** (`onOtpSendCalloutData`): `data.otpContext.{identifier, oneTimeCode}` + `data.authenticationContext.requestType`. Sample: [sample-payload.json](typescript/native-auth/otp-email-function/sample-payload.json).
- **Success response:** HTTP 200 with action `microsoft.graph.OtpSend.continueWithDefaultBehavior`.
- **Security:** protected by the Function App's built-in **Easy Auth** wired to the "Azure Functions authentication events API" app registration (validates Entra's bearer token); `authLevel: "function"` (system key) is a secondary factor, not the primary control.
- **App settings:** `COMMUNICATION_SERVICES_CONNECTION_STRING`, `COMMUNICATION_SERVICES_SENDER_ADDRESS`, optional `MAIL_SENDER_DISPLAY_NAME` (default "myServiceTas"), `BLOCKED_EMAILS`, `BLOCKED_DOMAINS`.
- **Runtime:** Node 22, Azure Functions **v4 programming model** (decorator-based, no `function.json`), TypeScript 5. Deps: `@azure/communication-email`, `@azure/functions`. Setup steps in [README.md](typescript/native-auth/otp-email-function/README.md).

---

## 5. Component 3 — OnTokenIssuanceStart extension (`token-issuance-function`)

Location: [typescript/native-auth/token-issuance-function/](typescript/native-auth/token-issuance-function/)
Main files: [src/functions/tokenIssuanceStart.ts](typescript/native-auth/token-issuance-function/src/functions/tokenIssuanceStart.ts) · [src/graphClient.ts](typescript/native-auth/token-issuance-function/src/graphClient.ts) · [claims-mapping-policy.json](typescript/native-auth/token-issuance-function/claims-mapping-policy.json)

> ✅ **Freshly merged (PR #9 `onTokenIssuanceStart`).** This is the newest piece of the demo — the MFA-phone-number-in-the-token feature. The full TypeScript source, README, `package.json`/`host.json`, a `sample-payload.json`, and a ready-to-apply `claims-mapping-policy.json` are all committed. (`local.settings.json` exists on disk with secrets but is correctly **not** committed.)

### 5.1 What it does & the problem it solves

When a user finishes authenticating and Entra is about to issue a token, it fires `OnTokenIssuanceStart`. This function calls **Microsoft Graph**, reads the user's **registered MFA phone number**, and returns it as a **custom claim** that gets embedded in the ID token — surfaced in the token as `phone_number`.

**Why a function is needed at all (the key talking point):** the MFA phone number is stored in Entra's **authentication-methods store, not as a directory profile attribute**. The portal's "Attributes & Claims" mapping can only reach directory attributes, so it physically cannot surface the MFA phone. A custom extension calling Graph on-demand is the supported workaround. Source: [tokenIssuanceStart.ts](typescript/native-auth/token-issuance-function/src/functions/tokenIssuanceStart.ts).

### 5.2 How it gets the number

- Reads the user id from the inbound payload (`data.authenticationContext.user.id`), then calls `GET https://graph.microsoft.com/v1.0/users/{id}/authentication/phoneMethods` (Graph app-only, scope `.default`), via [graphClient.ts](typescript/native-auth/token-issuance-function/src/graphClient.ts).
- **Picks the `phoneType === "mobile"` method, falling back to the first registered method**, and returns its `phoneNumber` (E.164).
- **Credential flexibility:** uses `@azure/identity` — `ClientSecretCredential` locally (`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET`/`GRAPH_TENANT_ID`) and `ManagedIdentityCredential` in Azure (system-assigned, or user-assigned via `GRAPH_MANAGED_IDENTITY_CLIENT_ID`). Credential cached per instance for warm-call speed.
- **Required Graph permission:** `UserAuthenticationMethod.Read.All` (application permission, admin-consented). Note: app-role assignments to a *managed identity* must be done via Graph/PowerShell — the portal can't do it.

### 5.3 Contract, claims mapping, resilience

- **Response:** action `microsoft.graph.tokenIssuanceStart.provideClaimsForToken` with `claims: { phoneNumber: "<E.164>" }`. Claim name configurable via `PHONE_CLAIM_ID` (default `phoneNumber`).
- **Important — two halves to ship the claim:** returning the claim is *not enough*; an **application claims-mapping policy** must also be assigned to the app. The repo includes that policy at [claims-mapping-policy.json](typescript/native-auth/token-issuance-function/claims-mapping-policy.json): it maps the `CustomClaimsProvider` ID `phoneNumber` → JWT claim type **`phone_number`** (the ID match is case-sensitive and must equal `PHONE_CLAIM_ID`). It is applied to the app via Graph. Without it, the claim never appears in the token.
- **Graceful degradation:** no phone registered, or any Graph error → returns **empty claims and the token is still issued**. Sign-in never breaks because of this extension. Handler/Graph timings are logged to diagnose cold starts against Entra's ~2s budget (`CustomExtensionTimedOut` = error 1003005).
- **Security:** same Easy Auth + bearer-token model as Component 2; `authLevel: "function"` as a secondary factor. Runtime is Node, Azure Functions **v4 programming model**, `@azure/functions` + `@azure/identity`.

---

## 6. Suggested live-demo sequence

1. **Show the branded app** (home page) — point out it's *our* UI, not a Microsoft redirect page. Note Service Tasmania logos/colours/font.
2. **Sign up a new user** — enter email → show the **branded OTP email** arriving (Component 2 in action) → complete attributes (try an invalid DOB to show server-side validation) → set password → register a mobile for MFA.
3. **Show the blocklist** — attempt sign-up with a blocked address/domain → friendly "can't be used" message (Component 2 returning 403; client showing the message).
4. **Sign in** with the new user → complete SMS MFA → land on the page showing **decoded ID-token claims** → point to the **`phone_number` claim** that Component 3 injected from Graph.
5. **(Optional) password reset** — show the same branded email + flow.

---

## 7. Pre-demo checklist & known caveats

- [ ] **Rotate / hide secrets.** `local.settings.json` in both functions holds real-looking secrets (ACS connection string; Graph client secret). They are git-ignored (good) but live on disk — **do not show these files on screen**, and rotate the Graph client secret after the demo. Production should use **managed identity** instead of a client secret.
- [ ] **Confirm the claims-mapping policy is assigned** to the SPA app via Graph — use the committed [claims-mapping-policy.json](typescript/native-auth/token-issuance-function/claims-mapping-policy.json). Without it, the MFA phone claim won't appear in the token (§5.3). Verify by signing in and checking `phone_number` is present in the decoded claims.
- [ ] **Confirm the Graph app/identity has `UserAuthenticationMethod.Read.All`** (admin-consented), or the token-issuance function can't read the phone number.
- [ ] **Both functions deployed & Easy Auth configured**, and the custom extensions registered/enabled in the Entra tenant.
- [ ] **ACS sender domain verified** and `BLOCKED_EMAILS`/`BLOCKED_DOMAINS` set to whatever you want to demo as "blocked".
- [ ] **This is POC code, not production.** The repo's own [security README](typescript/native-auth/README.md) flags: no CSRF protection on the forms, and an intentionally permissive (`*`) CORS policy in the sample proxy. Mention these are understood and would be hardened for production.
- [ ] Have a **known-good test account** pre-created in case live sign-up hits email-delivery latency.

---

## 8. Potential questions & answers

**Q: How is this different from the standard "Sign in with Microsoft" redirect?**
A: Standard Entra flows redirect the user to a Microsoft-hosted page. **Native authentication** keeps every step inside our own app via MSAL's custom-auth SDK, so the entire experience — UI, branding, verification emails, error messages — is ours. Entra is still the identity authority doing the actual credential/OTP/MFA validation behind the scenes.

**Q: If it's all client-side, is it secure? Where do credentials go?**
A: The SPA never holds long-term secrets. It talks to Entra's hardened native-auth API (through a same-origin proxy because those endpoints don't send CORS headers). Entra validates passwords, OTPs and MFA. Tokens are kept in `sessionStorage` and cleared when the tab closes. The two backend functions are protected by Entra-issued bearer tokens (Easy Auth). Caveat: this is *sample* code — it intentionally omits CSRF protection and uses a permissive CORS policy that we'd lock down for production (documented in the security README).

**Q: Why do we need custom Azure Functions at all — can't the portal do this?**
A: Two things the portal can't do. (1) **Branded OTP emails** — Entra's built-in emails are generic Microsoft-branded; the `OnOtpSend` extension lets us send our own. (2) **MFA phone number in the token** — that value lives in the authentication-methods store, not as a directory attribute, so the portal's claims mapping literally can't reach it; the `OnTokenIssuanceStart` extension fetches it from Graph. The functions are also where we enforce our **email blocklist** server-side.

**Q: What's the email blocklist for, and where is it enforced?**
A: It stops disposable/banned addresses or domains from being used. In native auth, the earliest server-side checkpoint is `OnOtpSend`, so the blocklist is enforced there — a blocked address gets no email and the flow fails with a friendly message. The list is held in app settings and (for instant UX) also checked in the browser. Note: it blocks across *all* OTP flows, not just sign-up, because a banned address should be banned everywhere.

**Q: Why is there a CORS proxy / `/api` layer? Isn't that extra complexity?**
A: It's required, not optional — Microsoft's native-auth REST endpoints don't return CORS headers, so a browser can't call them directly. The proxy is a thin same-origin forwarder (a Node script locally, an SWA-managed Azure Function in production). It also conveniently hosts our server-side attribute validation.

**Q: What happens if one of the Azure Functions is down or slow?**
A: **OnTokenIssuanceStart** degrades gracefully — if Graph is unreachable or the user has no phone, the token is still issued without the extra claim; sign-in never breaks. **OnOtpSend** is more critical: if it fails, the OTP email isn't sent. Entra supports a `fallbackToMicrosoftProviderOnError` setting so Entra sends its own default email if our function errors — worth enabling for resilience. Both must respond within Entra's ~2-second callout budget, which is why the email function returns before delivery completes.

**Q: Why validate sign-up attributes in our own API instead of an Entra extension?**
A: Because native auth doesn't fire the `OnAttributeCollectionStart/Submit` extensions (those only run in the browser user-flow). So we gate attributes (age 16–120, name rules, T&C) via our own `/api/validate-attributes` endpoint, called right before submission, and it fails closed if unavailable.

**Q: Is this production-ready?**
A: The pattern is sound and aligned with Microsoft's documented approach, but this specific repo is a **POC**: it lacks CSRF protection and uses a permissive CORS policy in the sample proxy. For production we'd harden CORS/CSRF and switch the functions from a client secret to **managed identity** for Graph access. The code itself (all three components) is fully committed and the claims-mapping policy is in the repo ready to assign.

**Q: How portable is this to other tenants / agencies?**
A: Quite portable. The tenant/app IDs are config (`auth-config.ts`, env vars on the functions), the branding is centralised (CSS tokens + email template), and the claim name is configurable. A new agency is largely a re-skin + new tenant config + its own claims-mapping policy.

**Q: What does the user actually get in the token?**
A: A standard Entra ID token plus our custom claim (the MFA `phone_number`). The app displays the decoded claims after sign-in so you can see exactly what's issued.

**Q: What MFA methods are supported?**
A: SMS to a registered phone, plus email OTP. The app supports **just-in-time registration** — if a user has no strong method, they're prompted to add one mid-flow (default dial code +61 for Australia).
