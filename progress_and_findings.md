# Entra External ID Migration — Progress & Findings

## 1. The two systems being compared

| | **Legacy (the markdown doc)** | **New (this repo)** |
|---|---|---|
| Product | Azure AD **B2C** custom policies | Microsoft **Entra External ID** (CIAM) |
| Tenant | `servicetasb2c.onmicrosoft.com` | `myservicetasdevpoc` (`a67366e7-9873-4a38-9bae-0a4a18952688`) |
| Identity logic | Hand-written XML user journey (21 orchestration steps) | Entra **user flow** + **custom authentication extensions** (Azure Functions) |
| Maturity | Production system, 6 environments | **Proof-of-concept**, single dev tenant |
| UI control | IEF self-asserted pages + custom HTML/CSS/JS | Two strategies: (A) **native auth** = our own React UI; (B) **browser-delegated** = Entra-hosted pages + custom CSS |
| App split | Two relying parties: **TFS** and **MST** | One SPA app id `5f0a52ca-f5db-4a6d-9b3a-3180d51fdd08`, shared by both samples |

The B2C document describes a mature, feature-rich production policy (id_token_hint SSO, TFS Dataverse provisioning, Conditional Access challenges, telemetry, MFA whitelist, etc.). This repo is the **migration POC**: it re-implements the *core* journey on Entra External ID and proves the patterns, while a number of the B2C system's peripheral features are either deliberately out of scope, blocked by platform limitations, or not yet built.

---

## 2. Architecture of the new implementation

Both samples target the **same tenant, same SPA app registration, and reuse the same four Azure Function extensions**. The only difference is *where the sign-in UI runs*.

```
                 ┌──────────────────────────────┐   ┌──────────────────────────────┐
                 │  NATIVE-AUTH React SPA        │   │  BROWSER-DELEGATED React SPA  │
                 │  our own forms (MSAL          │   │  MSAL loginRedirect() →       │
                 │  custom-auth) → /api proxy    │   │  Entra-hosted user-flow pages │
                 └───────────────┬──────────────┘   └───────────────┬──────────────┘
                                 │  native-auth REST (CORS-proxied)  │  OIDC redirect (no proxy)
                                 ▼                                   ▼
                          ┌─────────────────────────────────────────────────┐
                          │        Entra External ID  (user flow)            │
                          └───┬───────────────┬───────────────┬──────────────┘
        OnOtpSend ────────────┘               │               └──────── OnTokenIssuanceStart
        OnAttributeCollectionStart ───────────┘               OnAttributeCollectionSubmit
                                 (browser flow only — see §5)
                                 ▼                         ▼
   ┌────────────────────┐ ┌──────────────────────┐ ┌─────────────────────────┐ ┌──────────────────────────┐
   │ otp-email-function │ │ attribute-start-func │ │ attribute-submit-func   │ │ token-issuance-function  │
   │ ACS email+blocklist│ │ blocklist (browser)  │ │ DOB + displayName       │ │ phone_number + signin_   │
   │  OnOtpSend         │ │ OnAttributeColl.Start│ │ OnAttributeColl.Submit  │ │ email claims (Graph)     │
   └────────────────────┘ └──────────────────────┘ └─────────────────────────┘ └──────────────────────────┘
```

**Key shared facts**
- Both SPAs: Next.js 16 / React 19 / TypeScript, static export to **Azure Static Web Apps**, tokens in `sessionStorage`.
- Service Tasmania branding applied to both (native: in-app CSS/Nunito; browser-delegated: tenant Company-branding custom CSS — [custom-ui.css](typescript/browser-delegated/react-nextjs-sample/entra-config/custom-ui.css)).

---

## 3. Approach A — Native Authentication

**Idea:** every step (email, OTP, password, attributes, MFA) is *our own React UI* calling Entra's native-auth REST API via MSAL `@azure/msal-browser/custom-auth`. No Microsoft-hosted page.

### ✅ What works (implemented)
- **Sign-up** ([sign-up/page.tsx](typescript/native-auth/react-nextjs-sample/src/app/sign-up/page.tsx)): email → OTP → attribute collection (givenName, surname, dateOfBirth, termsAccepted) → password → JIT phone registration for MFA → auto sign-in.
- **Sign-in** ([page.tsx](typescript/native-auth/react-nextjs-sample/src/app/page.tsx)): email → password *or* passwordless email OTP → SMS MFA if required → JIT auth-method registration → decoded ID-token claims table.
- **Self-service password reset** ([reset-password/page.tsx](typescript/native-auth/react-nextjs-sample/src/app/reset-password/page.tsx)): email → OTP → new password → auto sign-in.
- **MFA (SMS)** with JIT registration (+61 default dial code).
- **Branded OTP emails** via the OnOtpSend extension (§5).
- **Email blocklist** enforced server-side at OnOtpSend, plus instant client-side UX check ([emailBlocklist.ts](typescript/native-auth/react-nextjs-sample/src/app/shared/utils/emailBlocklist.ts)).
- **Server-side attribute validation** ([api/src/attributeValidation.ts](typescript/native-auth/react-nextjs-sample/api/src/attributeValidation.ts)): age 16–120, name length/character rules, T&C must be true — fails *closed* if unreachable.
- **MFA phone-number claim** in the ID token via OnTokenIssuanceStart (§5).
- **Friendly error mapping** ([friendlyAuthError.ts](typescript/native-auth/react-nextjs-sample/src/app/shared/utils/friendlyAuthError.ts)) — raw `AADSTS…` codes never shown.
- **CORS proxy** ([api/src/functions/authProxy.ts](typescript/native-auth/react-nextjs-sample/api/src/functions/authProxy.ts) in prod, [cors.js](typescript/native-auth/react-nextjs-sample/cors.js) locally) — required because Entra's native-auth REST endpoints return no CORS headers.

### ⚠️ What doesn't work / constraints unique to native auth
- **`OnAttributeCollectionStart` / `OnAttributeCollectionSubmit` never fire in native auth.** This is the single biggest platform constraint. Consequence: attribute rules and the email blocklist's *earliest* checkpoint had to be re-built outside those extensions (own `/api/validate-attributes`; blocklist enforced at OnOtpSend). See §5 and §6.
- **No passkey** in the native-auth sample — it exists only in the browser-delegated sample because the native-auth APIs don't support passkeys yet.
- **Cold-start timeout risk** on OnTokenIssuanceStart (shared with browser-delegated) — see §5.4.

### ❓ Not yet investigated (native auth)
- Social / federated identity providers (Google, Apple, etc.).
- Native-auth behaviour under Conditional Access "block" / "password change" grant controls.
- Production hardening of the proxy (CSRF, tightened CORS — see §7).

---

## 4. Approach B — Browser-Delegated

**Idea:** MSAL `loginRedirect()` hands the whole sign-up/sign-in/reset UI to Entra-hosted user-flow pages; the SPA only starts the redirect and reads tokens. **No CORS proxy for sign-in.**

### ✅ What works (implemented)
- **Sign-in / Sign-up / Sign-out** via redirect to the hosted `ServiceTas_SignUpSignIn` user flow. `prompt=login` forces fresh auth (avoids a stale-session reprocess loop); `prompt=create` jumps straight to sign-up (mirrors B2C "Sign up now"). See [auth-config.ts](typescript/browser-delegated/react-nextjs-sample/src/config/auth-config.ts).
- **Password reset** ([reset-password/page.tsx](typescript/browser-delegated/react-nextjs-sample/src/app/reset-password/page.tsx)) — routed into the hosted SSPR "Forgot password?" link (no separate policy/authority, unlike B2C's `B2C_1A_PasswordReset`).
- **Branded block page for blocklisted sign-up emails** — the OnAttributeCollectionStart extension returns `showBlockPage` for blocked addresses during hosted sign-up.
- **ID-token claims view** with the custom `phone_number` claim surfaced ([page.tsx](typescript/browser-delegated/react-nextjs-sample/src/app/page.tsx)).
- **Passkey (FIDO2) management** ([security/page.tsx](typescript/browser-delegated/react-nextjs-sample/src/app/security/page.tsx)) — add / list / delete via Graph **beta** `fido2Methods` + WebAuthn. *No B2C equivalent.* Sign-in *with* a passkey needs zero app code (Entra-hosted page offers it automatically); only *registration/management* needs the app. Requires being served from the RP domain (`myservicetasdevpoc.ciamlogin.com`) — locally faked with a hosts entry + self-signed cert.
- **Account self-management** ([account/page.tsx](typescript/browser-delegated/react-nextjs-sample/src/app/account/page.tsx)):
  - **Change sign-in email** — OTP-verifies the new address (ACS email), then patches Graph `identities[]` (needs `User.ManageIdentities.All`), syncs email OTP method + profile `mail`/`otherMails`.
  - **Change mobile (MFA) number** — patches/creates the `mobile` phoneMethod; dial-code dropdown (+61 / +64).
  - **Change password** — routed into hosted SSPR (Graph `resetPassword` has no app-only/external-tenant self-service path).
- **Fresh-MFA gate** for sensitive operations via the `ngcmfa` claims challenge ([ngcmfaClaims](typescript/browser-delegated/react-nextjs-sample/src/config/auth-config.ts)), with redirect-and-resume handling.
- **App-only Graph proxy** ([local-proxy.mjs](typescript/browser-delegated/react-nextjs-sample/local-proxy.mjs)) — single Node server fronting passkey + account Graph APIs; verifies the caller's ID token (signature/iss/aud/exp), derives `oid` so a caller can only manage their own account, and holds the client secret server-side.

### ⚠️ What doesn't work / constraints
- **Account self-service entry points only appear on dev hosts** (`localhost` / passkey RP host) by default — the deployed static export has no proxy. Production needs the proxy logic moved into an Azure Function behind the SWA and `NEXT_PUBLIC_ACCOUNT_API_BASE` set at build time. (UI hides the links rather than dead-ending — [accountFeatureAvailable()](typescript/browser-delegated/react-nextjs-sample/src/config/auth-config.ts).)
- **Passkey registration needs the RP domain** — not usable on plain `localhost`; production requires a **custom URL domain**.
- **MFA re-verification can't be proven server-side from the token.** External ID CIAM tokens carry **no `amr` claim**, so the proxy's fresh-MFA backstop falls back to an `iat` age check (≤15 min); the real gate is the `ngcmfa` claims challenge at token request time.
- **Stale `email`/`preferred_username` after a sign-in-email change** when an older credential (e.g. a passkey) is used.
- **Cold-start timeout risk** on OnTokenIssuanceStart — see §5.4.

### ❓ Not yet investigated (browser-delegated)
- Production deployment of the account/passkey proxy as a real backend (only `local-proxy.mjs` exists).
- Custom URL domain setup for production passkeys.

---

## 5. Shared backend — the four custom authentication extensions

| Function | Event | Status | Fires in native? | Fires in browser? |
|---|---|---|---|---|
| [otp-email-function](typescript/native-auth/otp-email-function/) | `OnOtpSend` | ✅ Active | **Yes** | Yes |
| [attribute-start-function](typescript/native-auth/attribute-start-function/) | `OnAttributeCollectionStart` | ✅ Active (browser sign-up) | **No** | Yes |
| [attribute-submit-function](typescript/native-auth/attribute-submit-function/) | `OnAttributeCollectionSubmit` | ✅ Active (validation only) | **No** | Yes |
| [token-issuance-function](typescript/native-auth/token-issuance-function/) | `OnTokenIssuanceStart` | ✅ Active | **Yes** | Yes |

### 5.1 otp-email-function (OnOtpSend) — ✅ works
- Sends a **branded Service Tasmania OTP email** via Azure Communication Services. Entra still generates/validates the code; we only deliver the email. One handler covers sign-up, sign-in OTP, reset, and email MFA.
- Returns immediately after `beginSend()` (does *not* await delivery) to stay inside Entra's ~2s callout budget.
- **Email blocklist** ([emailBlocklist.ts](typescript/native-auth/otp-email-function/src/emailBlocklist.ts)) from `BLOCKED_EMAILS` / `BLOCKED_DOMAINS` app settings. Blocked address → **HTTP 403, no OTP sent**. Since PR #24 the block is scoped by `requestType`: it fires for **every flow except browser-delegated sign-up** (`requestType === "signUp"`), which it deliberately lets through so OnAttributeCollectionStart can render a *branded* block page instead of OnOtpSend's generic error. Native auth (different/empty `requestType`) and browser sign-in / reset / MFA stay hard-blocked here. See §6.

### 5.2 attribute-start-function (OnAttributeCollectionStart) — ✅ works
- Enforces the email blocklist for the **browser-delegated sign-up** flow.
- Reads the verified email from `data.userSignUpInfo.identities` (matches any `signInType` starting with `email`, falling back to any `issuerAssignedId` containing `@`); on a blocklist hit it returns **`showBlockPage`** with a branded title + message — the friendly, hosted-UI counterpart to OnOtpSend's generic 403.
- Native auth never reaches this event, so its enforcement stays in OnOtpSend (§5.1). It also can't run *before* the email OTP — Entra has no pre-OTP extension point — so a blocked browser sign-up has already received its OTP by the time it's stopped here.

### 5.3 attribute-submit-function (OnAttributeCollectionSubmit) — ✅ validation only
- **Implemented:** date-of-birth validation (DD/MM/YYYY, real calendar date, **age ≥ 16**), and composes `displayName` from givenName + surname. Returns `modifyAttributeValues` / `showValidationError` / `continueWithDefaultBehavior`.

### 5.4 token-issuance-function (OnTokenIssuanceStart) — ✅ works, with cold-start caveat
- Reads the user's **MFA phone number** from Graph `authentication/phoneMethods` (prefers `mobile`) and emits it as a custom claim mapped to JWT `phone_number`. This solves a real B2C-parity problem: the MFA phone lives in the auth-methods store, *not* as a directory attribute, so portal claim mapping physically can't reach it.
- Requires **two halves**: the function returning the claim **and** the [claims-mapping-policy.json](typescript/native-auth/token-issuance-function/claims-mapping-policy.json) being assigned to the app. Without the policy, the claim never appears.
- **Graceful degradation:** no phone / Graph error / timeout → token still issued without the claim; sign-in doesn't break.
- **⚠️ Known cold-start issue:** Entra caps this callout at ~2s; the `phoneMethods` call alone routinely takes 1–2.5s. A cold function instance blows the budget → `AADSTS1100001` / `1003005 CustomExtensionTimedOut`, and **sign-in returns with no token on the first attempt but might succeed on retry**. Mitigations in code: a bounded Graph deadline (`GRAPH_TIMEOUT_MS` = **1800ms**), per-instance credential caching. The durable fix is keeping the function warm.

---

## 6. The email-blocklist story

No single Entra hook covers every flow, so blocklist enforcement is **split across two server extensions, routed by `requestType`** so each flow gets the best UX:

| Flow | Enforced at | What the user sees |
|---|---|---|
| Native auth (sign-up / sign-in / reset / MFA) | **OnOtpSend** → 403, no OTP | React client's own friendly pre-`signUp()` message |
| Browser-delegated **sign-up** | **OnAttributeCollectionStart** → `showBlockPage` | Branded block page (OTP is allowed to send first) |
| Browser-delegated sign-in / reset / MFA | **OnOtpSend** → 403, no OTP | Generic hosted-UI error |

Why split: OnOtpSend has no `showBlockPage` action, so blocking there renders Entra's *generic* error — fine for native auth (the React client supplies the friendly text) and for browser non-sign-up flows, but poor UX for a new user signing up on the hosted pages. OnAttributeCollectionStart *can* `showBlockPage`, so browser sign-up is deliberately deferred to it.

The blocklist data still lives in **three copies that must be kept in sync** (no shared package):

1. [otp-email-function/src/emailBlocklist.ts](typescript/native-auth/otp-email-function/src/emailBlocklist.ts) — native auth + browser non-sign-up enforcement.
2. [attribute-start-function/src/emailBlocklist.ts](typescript/native-auth/attribute-start-function/src/emailBlocklist.ts) — browser sign-up enforcement (branded page).
3. [react-nextjs-sample/src/app/shared/utils/emailBlocklist.ts](typescript/native-auth/react-nextjs-sample/src/app/shared/utils/emailBlocklist.ts) — client-side UX only (hardcoded; bypassable; not a security boundary).

---

## 7. B2C → Entra External ID feature-parity matrix

Legend: ✅ implemented/works · 🟡 partial / different mechanism · ⛔ blocked by platform · ❌ not built · ❓ not investigated

| # | B2C feature (from the doc) | Native auth | Browser-delegated | Notes |
|---|---|---|---|---|
| 1 | Combined sign-up / sign-in | ✅ (our UI) | ✅ (hosted) | Both via one user flow |
| 2 | Email OTP verification | ✅ | ✅ | Branded via OnOtpSend |
| 3 | Branded verification email | ✅ | ✅ | ACS email, Service Tas branding |
| 4 | Password policy (8–20, 3-of-4 regex) | 🟡 | 🟡 | Entra's **fixed** policy (8–256, 3-of-4) applies; B2C's exact regex/length **can't be enforced** |
| 5 | MFA (SMS) | ✅ | ✅ | + email OTP; JIT registration |
| 6 | MFA session (30-min skip) | 🟡 | 🟡 | Handled by Entra session/CA, not custom XML; not explicitly tuned |
| 7 | MFA whitelist (hardcoded `doolse@…`) | 🟡 | 🟡 | Replaced by **CA exclusion via security group** (auditable) — documented, not scripted in repo |
| 8 | Conditional Access risk eval | 🟡 | 🟡 | Native Entra CA policies (limited) |
| 9 | CA **block** page | 🟡 | 🟡 | Achievable via a CA Block policy (documented) |
| 10 | CA **password-change** (`chg_pwd`) | ⛔ | ⛔ | External ID CA has **no `chg_pwd` grant control** (documented gap) |
| 11 | Sign-up attribute collection | ✅ (own `/api`) | ✅ (OnAttrSubmit) | Native validates via own API; browser via the submit extension |
| 12 | Attribute validation (age/name/T&C) | ✅ | ✅ | Native: full rules in `/api`. Browser: only DOB+displayName in the extension; name/T&C rely on flow config |
| 13 | Email **blocklist** | ✅ (OnOtpSend) | ✅ | Native: 403 at OnOtpSend. Browser sign-up: branded `showBlockPage` at OnAttributeCollectionStart; browser sign-in/reset/MFA: 403 at OnOtpSend |
| 14 | MFA phone number in token | ✅ | ✅ | OnTokenIssuanceStart + claims-mapping policy |
| 15 | DOB / T&C custom claims | ✅ | ✅ | Custom attributes `dateOfBirth`, `termsAndConditions`, `termsAndConditionsTfs` |
| 16 | App-specific flow (**TFS vs MST**) | ❌ | ❌ | One app id, one flow; no `client_id` branching implemented |
| 17 | **TFS Dataverse provisioning** (checkUser/createSignUp) | ❌ | ❌ | Not yet implemented |
| 18 | REST `CheckValidEmail` (domain gate) | 🟡 | ❌ | Native's `/api/validate-attributes` is the nearest analogue; no external domain-allow REST call |
| 19 | **`id_token_hint` cross-app SSO** | ⛔ | ⛔ | **Not supported by user flows**; the entire mint/consume SSO subsystem is unported |
| 20 | Password reset (SSPR) | ✅ | ✅ | Native: own flow. Browser: hosted "Forgot password?" |
| 21 | Profile edit — phone number | ❌ | ✅ | Browser `/account`; not yet implemented in native sample |
| 22 | Profile edit — change sign-in email | ❌ | ✅ | Browser `/account` (OTP-verified, Graph identities patch); not yet implemented in native sample |
| 23 | Change password (authenticated) | 🟡 | 🟡 | Both route to hosted SSPR (no app-only Graph path) |
| 24 | **Passkeys (FIDO2)** | ❌ (unsupported) | ✅ | *No B2C equivalent* — new capability; native-auth APIs don't support passkeys |
| 25 | App Insights per-step telemetry | ❌ | ❌ | No per-step `TrackEvent`; rely on Entra sign-in logs + Function App Insights |
| 26 | Multi-environment config (6 envs) | 🟡 | 🟡 | Single dev tenant; values are config-driven but only one environment exists |
| 27 | Custom page HTML/JS | ✅ | ⛔ | Browser: **CSS-only** company branding (no HTML/JS templates, no web fonts); Native: full control (it's our app) |

---

## 8. Headline findings

1. **Two complementary strategies, one backend.** Native auth (full UI control) and browser-delegated (low-code, hosted) are both viable on Entra External ID and share the same four extensions + tenant. Native auth maximises branding; browser-delegated unlocks passkeys and is far less code.
2. **The defining platform constraint:** **`OnAttributeCollectionStart`/`Submit` do not fire in native auth.** This forced attribute validation into a custom `/api` and shaped the email-blocklist design — now a settled split keyed on `requestType`: OnOtpSend (403) for native auth and browser non-sign-up flows, OnAttributeCollectionStart (branded `showBlockPage`) for browser sign-up.
3. **The MFA-phone-in-token pattern works** and is a clean win over B2C's approach — but it lives on Entra's ~2s callout budget and has a real **cold-start failure mode** that intermittently breaks first-attempt sign-in. Actively mitigated; not yet bulletproof.
4. **Passkeys are a net-new capability** with no B2C equivalent — fully built for management, free for sign-in, but gated on the RP-domain requirement (custom domain in prod).
5. **Account self-service (email/phone change)**: runs app-only behind a proxy, MFA freshness can't be read from the token (no `amr`), and identity reads can be masked.

---

## 9. Areas not yet investigated

**Not built yet (candidates for future work):**
- `id_token_hint` cross-app SSO (entire mint+consume subsystem).
- **TFS vs MST app-specific branching** (`client_id` → app-access logic).
- **TFS Dataverse provisioning** backend.
- **Conditional Access policies** (require password change, require risk remediation, block) behaviour end-to-end in both flows.
- **Production proxy** for the browser-delegated account/passkey features (only `local-proxy.mjs` exists).

**Production hardening:**
- CSRF protection on the native-auth forms.
- Rotate/secure the secrets currently in `local.settings.json` / `.env.local`.

---
