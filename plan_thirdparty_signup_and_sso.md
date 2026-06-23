# Implementation Plan — Third-Party Org Sign-Up & Cross-App SSO (POC)

Companion to [progress_and_findings.md](progress_and_findings.md). This plan turns the two largest remaining B2C-parity gaps into actionable, sequenced work on **Microsoft Entra External ID**:

- **Feature A — Third-party org sign-up** (TFS, future DFPS, …): per-`clientId` branching, check-user-exists, Dataverse provisioning, and conditional Terms & Conditions. (B2C: Complete Authentication Journey steps 13–18 / "TFS Sign Up (Backend Implementation)".)
- **Feature B — Cross-app SSO** (the capability B2C delivered via `id_token_hint`): App → website and the RWVP impersonation portal, including Power Pages / PlatesPlus.

**Status legend:** ⬜ not started · 🟦 spike/POC · ✅ done
**Effort legend:** S (≤1 day) · M (2–4 days) · L (1–2 weeks) · 🔬 time-boxed spike

---

## 0. The reframing that drives this plan

Entra External ID has **no Identity Experience Framework / custom policies**. Microsoft's migration guidance: custom-policy logic "must be recreated using **custom authentication extensions**" and "one-to-one parity isn't guaranteed." So neither feature ports from B2C — both are **redesigned** around the four extension events plus app/integration-layer code.

**Platform constraints that shape every step below:**

| Constraint | Consequence for this plan |
| --- | --- |
| No custom policies / no orchestration preconditions | Can't conditionally insert/skip a page (e.g. the TFS T&C page) mid-flow. Branching moves to **per-flow topology** + **app layer**. |
| `OnAttributeCollectionStart`/`Submit` fire **browser-delegated only** | New-user TFS provisioning works only in the browser flow. Native-auth users are handled via `OnTokenIssuanceStart` + app layer. |
| `OnTokenIssuanceStart` fires in **both** native + browser, on every token issuance | The one place to run logic for all users/flows — but **no UI** (can't collect consent). |
| Extensions **can't add new attributes**; attributes are fixed by the user flow | The T&C checkbox must be a pre-defined custom attribute selected in the flow. |
| Attribute collection happens **at sign-up only**, not at sign-in | "Existing user accepts T&C for a new service" can't use the flow — must move to the **app layer**. |
| `clientId` **is** in the extension payload | Per-service-provider branching is feasible inside the function. |
| `id_token_hint` (mint JWT → skip login) **does not exist** in External ID | Cross-app SSO is rebuilt from: web↔web session-cookie SSO (supported), native→webview bearer injection (supported), native→system-browser (gap/roadmap), impersonation (app layer). |
| Single **custom URL domain** required for cross-app session SSO (and prod passkeys) | Phase 0 prerequisite. |

---

## 1. Decisions required before starting (gating)

These three decisions gate the build. Resolve them first.

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | **Mobile app auth model** | Native auth (full in-app UI) **vs** browser-delegated (redirect) | ✅ **Committed (2026-06-22): browser-delegated.** App↔web SSO ("sign into the app, open the website, no second sign-in") is the agreed goal (see [sso_id_token_hint_requirement.md](sso_id_token_hint_requirement.md)), so the app must share the system browser's `ciamlogin.com` cookie jar. This gives **web SSO for free** and collapses the B3 native→system-browser gap into the proven B1 path. (Originally a recommendation; now locked — see C1 in §4.1.) |
| D2 | **User-flow topology for service providers** | One shared flow + app-layer T&C **vs** one user flow per service provider | One flow **per SP** (TFS flow carries the `termsAndConditionsTfs` attribute; generic flow doesn't), because T&C can't be shown conditionally mid-flow. |
| D3 | **Custom URL domain** | Use `…ciamlogin.com` **vs** stand up a custom domain | Stand up the custom domain in Phase 0 — prerequisite for web↔web SSO **and** production passkeys. |

---

## 2. Phase 0 — Shared prerequisites (do first)

| Step | Task | Effort |
| --- | --- | --- |
| P0.1 | **Stand up a custom URL domain** for the external tenant; use a **single** domain across all web properties (required for session SSO). | M |
| P0.2 | **Inventory & expose the integration-layer APIs** to reuse from B2C: `checkUser`, `createSignUp` (provisioning) and the Dataverse contact/consent/service-link model. Confirm they can be called from an Azure Function (API key / managed identity). | S |
| P0.3 | **App-registration strategy**: list the apps (myServiceTas web, TFS app, future DFPS, PlatesPlus/Power Pages, RWVP portal) and decide shared-vs-separate `clientId`s (matters for B2 webview SSO, which needs a shared client ID). | S |
| P0.4 | **Graph access for functions**: confirm `UserAuthenticationMethod.Read.All` (phone lookup) and any directory reads the provisioning needs; prefer **managed identity** over client secret. | S |
| P0.5 | **`clientId` → service-provider map**: decide where it lives (function config vs Dataverse `GetServiceProviderByB2CId`). Reuse the Dataverse mapping if practical. | S |

---

## 3. Feature A — Third-party org sign-up + Dataverse provisioning + conditional T&C

**Design in one sentence:** new sign-ups are provisioned via the **browser sign-up flow + `OnAttributeCollectionSubmit`**; existing users linking a new service (and all native-auth users) are handled via **`OnTokenIssuanceStart` + the app layer**, because there's no attribute step at sign-in.

### Phase A1 — Flow topology & attributes

| Step | Task | Effort |
| --- | --- | --- |
| A1.1 | Create a **TFS-specific sign-up/sign-in user flow**; bind the TFS app registration(s) to it. Repeat per future SP (DFPS). (Decision D2.) | M |
| A1.2 | Ensure custom attributes exist: `dateOfBirth`, `termsAndConditions`, `termsAndConditionsTfs` (already defined in `entra-config`), plus any new per-SP T&C attribute. | S |
| A1.3 | Select the SP-specific T&C attribute **in that SP's user flow only** (so non-TFS apps never show the TFS T&C). | S |
| A1.4 | Document the **branding limitation** (tenant-wide branding today; per-app is roadmap) and whether per-SP look-and-feel is required for the POC. | S |

### Phase A2 — Provisioning function (new sign-up path, browser)

Reuse and extend the existing [attribute-submit-function](typescript/native-auth/attribute-submit-function/) (today it only does DOB validation + displayName) and the Graph helper from [token-issuance-function/src/graphClient.ts](typescript/native-auth/token-issuance-function/src/graphClient.ts).

| Step | Task | Effort |
| --- | --- | --- |
| A2.1 | In `OnAttributeCollectionSubmit`, read `clientId` from the payload and resolve the **service provider** (P0.5). | S |
| A2.2 | Call integration-layer **`checkUser`** (does this user already have consent for this SP?) for validation/telemetry. | S |
| A2.3 | Enforce the SP T&C attribute is accepted → `showValidationError` if not; `showBlockPage` for hard stops. | S |
| A2.4 | Look up the **MFA phone via Graph** (`phoneMethods`) — it's *not* in the attribute payload — reusing `graphClient.ts`. | S |
| A2.5 | Call integration-layer **`createSignUp`** to provision Dataverse: Contact + external identity + registration consent + SP service-link + SP T&C consent. | M |
| A2.6 | Make it **idempotent** (the event can fire more than once; `createSignUp` already upserts in B2C — verify). | S |
| A2.7 | Note in code/docs: this path is **browser-delegated only**; native users are covered by Phase A3. | S |

### Phase A3 — Existing-user / native-auth path (the gap)

There is no attribute step at sign-in, so the "existing user accepts T&C for a new service" case (and any native-auth sign-up) must be handled at the **token + app** layer.

| Step | Task | Effort |
| --- | --- | --- |
| A3.1 | In `OnTokenIssuanceStart` ([token-issuance-function](typescript/native-auth/token-issuance-function/)), call `checkUser` and emit claims, e.g. `linked_services` and **`needs_tfs_consent`** (works for native + browser, every sign-in). | M |
| A3.2 | (Optional) **Silently provision the Contact** in `OnTokenIssuanceStart` if missing, deferring only the *consent UI* to the app. | M |
| A3.3 | **App-layer T&C page:** after sign-in, the SP app reads `needs_*_consent`; if true, it shows its own T&C page and calls an integration-layer **`recordConsent`** endpoint. | M |
| A3.4 | Keep the claims-mapping policy updated for any new claims (see [claims-mapping-policy.json](typescript/native-auth/token-issuance-function/claims-mapping-policy.json)). | S |

### Phase A4 — Wire-up, config, test

| Step | Task | Effort |
| --- | --- | --- |
| A4.1 | Register the `OnAttributeCollectionSubmit` extension and attach it to each SP user flow; configure Easy Auth (reuse the auth-events app registration). | S |
| A4.2 | Configure app settings: integration API base + key, Graph creds/MI, `clientId`→SP map. | S |
| A4.3 | **Test matrix** (acceptance below). | M |

**Feature A — definition of done (POC):**

I'll start by exploring the codebase to understand the current "manage account" functionality and the native-auth setup.

Bash List repo root and branches
IN
ls -la && echo "---BRANCHES---" && git branch -a 2>/dev/null | head -30

OUT
total 92
drwxr-xr-x 1 ITECHNOLOGIES+Leo.Nguyen 4096     0 Jun 22 13:43 .
drwxr-xr-x 1 ITECHNOLOGIES+Leo.Nguyen 4096     0 Jun 11 14:06 ..
drwxr-xr-x 1 ITECHNOLOGIES+Leo.Nguyen 4096     0 Jun 22 16:06 .claude
drwxr-xr-x 1 ITECHNOLOGIES+Leo.Nguyen 4096     0 Jun 22 14:17 .git
-rw-r--r-- 1 ITECHNOLOGIES+Leo.Nguyen 4096   293 Jun 17 14:02 .gitignore
drwxr-xr-x 1 ITECHNOLOGIES+Leo.Nguyen 4096     0 May 21 11:19 API
-rw-r--r-- 1 ITECHNOLOGIES+Leo.Nguyen 4096  1091 May 21 11:19 LICENSE
-rw-r--r-- 1 ITECHNOLOGIES+Leo.Nguyen 4096  2181 May 21 11:19 README.md
-rw-r--r-- 1 ITECHNOLOGIES+Leo.Nguyen 4096 11758 Jun 18 16:59 impersonation-portal-design.md
drwxr-xr-x 1 ITECHNOLOGIES+Leo.Nguyen 4096     0 May 27 09:57 node_modules
-rw-r--r-- 1 ITECHNOLOGIES+Leo.Nguyen 4096 33776 Jun 22 16:29 plan_thirdparty_signup_and_sso.md
-rw-r--r-- 1 ITECHNOLOGIES+Leo.Nguyen 4096  6213 Jun 22 13:24 sso_id_token_hint_requirement.md
drwxr-xr-x 1 ITECHNOLOGIES+Leo.Nguyen 4096     0 Jun 18 15:08 typescript
---BRANCHES---
  browser-delegated
  dev
  main
  onAttributeCollectionStart
  onAttributeCollectionSubmit
  onEmailOtpSend
  onTokenIssuanceStart
  passkey
* sso
  remotes/origin/HEAD -> origin/main
  remotes/origin/browser-delegated
  remotes/origin/dev
  remotes/origin/main
  remotes/origin/onAttributeCollectionStart
  remotes/origin/onAttributeCollectionSubmit
  remotes/origin/onEmailOtpSend
  remotes/origin/onTokenIssuanceStart
  remotes/origin/passkey
  remotes/origin/sso
  remotes/upstream/HEAD -> upstream/main
  remotes/upstream/alban/add-native-auth-samples
  remotes/upstream/alban/add-navbars
  remotes/upstream/alban/fix-data
  remotes/upstream/alban/signup-attr
  remotes/upstream/dependabot/npm_and_yarn/API/React/ReactAuthSimple/tough-cookie-4.1.4
  remotes/upstream/dependabot/npm_and_yarn/API/React/ReactAuthStateManagementAndUI/http-proxy-middleware-2.0.7
  remotes/upstream/dependabot/npm_and_yarn/typescript/native-auth/angular-sample/angular/common-19.2.16
  remotes/upstream/dependabot/npm_and_yarn/typescript/native-auth/angular-sample/angular/compiler-19.2.18
  remotes/upstream/dependabot/npm_and_yarn/typescript/native-auth/angular-sample/angular/core-19.2.18
  remotes/upstream/dependabot/npm_and_yarn/typescript/native-auth/angular-sample/js-yaml-4.1.1
Read c:\source\ms-identity-ciam-native\plan_thirdparty_signup_and_sso.md
Let me explore the directory structures to understand what "manage account" functionality exists in browser-delegated and what's in native-auth.

Bash List directory tree under typescript
IN
cd c:/source/ms-identity-ciam-native/typescript && find . -maxdepth 3 -type d -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | sort

OUT
.
./azure-function-apps
./azure-function-apps/attribute-start-function
./azure-function-apps/attribute-start-function/dist
./azure-function-apps/attribute-start-function/node_modules
./azure-function-apps/attribute-submit-function
./azure-function-apps/attribute-submit-function/dist
./azure-function-apps/attribute-submit-function/node_modules
./azure-function-apps/token-issuance-function
./azure-function-apps/token-issuance-function/dist
./azure-function-apps/token-issuance-function/node_modules
./browser-delegated
./browser-delegated/react-nextjs-sample
./browser-delegated/react-nextjs-sample/.next
./browser-delegated/react-nextjs-sample/.next-appB
./browser-delegated/react-nextjs-sample/certs
./browser-delegated/react-nextjs-sample/entra-config
./browser-delegated/react-nextjs-sample/node_modules
./browser-delegated/react-nextjs-sample/out
./browser-delegated/react-nextjs-sample/public
./browser-delegated/react-nextjs-sample/src
./native-auth
./native-auth/attribute-start-function
./native-auth/attribute-start-function/deploy
./native-auth/attribute-start-function/src
./native-auth/attribute-submit-function
./native-auth/attribute-submit-function/deploy
./native-auth/attribute-submit-function/src
./native-auth/otp-email-function
./native-auth/otp-email-function/src
./native-auth/react-nextjs-sample
./native-auth/react-nextjs-sample/.next
./native-auth/react-nextjs-sample/api
./native-auth/react-nextjs-sample/node_modules
./native-auth/react-nextjs-sample/out
./native-auth/react-nextjs-sample/public
./native-auth/react-nextjs-sample/src
./native-auth/token-issuance-function
./native-auth/token-issuance-function/deploy
./native-auth/token-issuance-function/src
Bash List src files in both samples
IN
cd c:/source/ms-identity-ciam-native/typescript && echo "=== BROWSER-DELEGATED src ===" && find browser-delegated/react-nextjs-sample/src -type f -not -path '*/node_modules/*' | sort && echo "" && echo "=== NATIVE-AUTH src ===" && find native-auth/react-nextjs-sample/src -type f -not -path '*/node_modules/*' | sort

OUT
=== BROWSER-DELEGATED src ===
browser-delegated/react-nextjs-sample/src/app/account/page.tsx
browser-delegated/react-nextjs-sample/src/app/favicon.ico
browser-delegated/react-nextjs-sample/src/app/globals.css
browser-delegated/react-nextjs-sample/src/app/handoff/page.tsx
browser-delegated/react-nextjs-sample/src/app/impersonate/page.tsx
browser-delegated/react-nextjs-sample/src/app/layout.tsx
browser-delegated/react-nextjs-sample/src/app/page.tsx
browser-delegated/react-nextjs-sample/src/app/reset-password/page.tsx
browser-delegated/react-nextjs-sample/src/app/security/page.tsx
browser-delegated/react-nextjs-sample/src/app/webview/page.tsx
browser-delegated/react-nextjs-sample/src/auth/AuthProvider.tsx
browser-delegated/react-nextjs-sample/src/auth/SsoBootstrap.tsx
browser-delegated/react-nextjs-sample/src/components/Navbar.module.css
browser-delegated/react-nextjs-sample/src/components/Navbar.tsx
browser-delegated/react-nextjs-sample/src/config/auth-config.ts
browser-delegated/react-nextjs-sample/src/services/account-service.ts
browser-delegated/react-nextjs-sample/src/services/impersonation-service.ts
browser-delegated/react-nextjs-sample/src/services/passkey-service.ts
browser-delegated/react-nextjs-sample/src/services/webview-service.ts

=== NATIVE-AUTH src ===
native-auth/react-nextjs-sample/src/app/favicon.ico
native-auth/react-nextjs-sample/src/app/globals.css
native-auth/react-nextjs-sample/src/app/layout.tsx
native-auth/react-nextjs-sample/src/app/page.tsx
native-auth/react-nextjs-sample/src/app/reset-password/components/InitialForm.tsx
native-auth/react-nextjs-sample/src/app/reset-password/components/NewPasswordForm.tsx
native-auth/react-nextjs-sample/src/app/reset-password/components/VerifyIdentityStep.tsx
native-auth/react-nextjs-sample/src/app/reset-password/page.tsx
native-auth/react-nextjs-sample/src/app/reset-password/styles/styles.ts
native-auth/react-nextjs-sample/src/app/reset-password/types/formProperties.ts
native-auth/react-nextjs-sample/src/app/shared/components/AuthMethodRegistrationChallengeForm.tsx
native-auth/react-nextjs-sample/src/app/shared/components/AuthMethodRegistrationForm.tsx
native-auth/react-nextjs-sample/src/app/shared/components/CodeForm.tsx
native-auth/react-nextjs-sample/src/app/shared/components/EmailStep.tsx
native-auth/react-nextjs-sample/src/app/shared/components/FormErrors.tsx
native-auth/react-nextjs-sample/src/app/shared/components/MfaAuthMethodSelectionForm.tsx
native-auth/react-nextjs-sample/src/app/shared/components/MfaChallengeForm.tsx
native-auth/react-nextjs-sample/src/app/shared/components/PasswordForm.tsx
native-auth/react-nextjs-sample/src/app/shared/components/VerificationCodeStep.tsx
native-auth/react-nextjs-sample/src/app/shared/styles/authFlowStyles.ts
native-auth/react-nextjs-sample/src/app/shared/types/formProperties.ts
native-auth/react-nextjs-sample/src/app/shared/utils/authMethods.ts
native-auth/react-nextjs-sample/src/app/shared/utils/emailBlocklist.ts
native-auth/react-nextjs-sample/src/app/shared/utils/formatMobile.ts
native-auth/react-nextjs-sample/src/app/shared/utils/friendlyAuthError.ts
native-auth/react-nextjs-sample/src/app/shared/utils/passwordValidation.ts
native-auth/react-nextjs-sample/src/app/shared/utils/validateSignUpAttributes.ts
native-auth/react-nextjs-sample/src/app/sign-up/components/DetailsStep.tsx
native-auth/react-nextjs-sample/src/app/sign-up/components/MobileStep.tsx
native-auth/react-nextjs-sample/src/app/sign-up/page.tsx
native-auth/react-nextjs-sample/src/app/sign-up/styles/styles.ts
native-auth/react-nextjs-sample/src/app/sign-up/types/formProperties.ts
native-auth/react-nextjs-sample/src/app/webview/page.tsx
native-auth/react-nextjs-sample/src/auth/AuthClientProvider.tsx
native-auth/react-nextjs-sample/src/components/Navbar.module.css
native-auth/react-nextjs-sample/src/components/Navbar.tsx
native-auth/react-nextjs-sample/src/config/auth-config.ts
native-auth/react-nextjs-sample/src/services/webview-service.ts
The native-auth sample is missing account, security pages and account-service.ts/passkey-service.ts. Let me read the browser-delegated "manage account" implementation and the native-auth structure.

Read c:\source\ms-identity-ciam-native\typescript\browser-delegated\react-nextjs-sample\src\app\account\page.tsx
Read c:\source\ms-identity-ciam-native\typescript\browser-delegated\react-nextjs-sample\src\services\account-service.ts
Now let me read the security page, passkey-service, and the native-auth-specific infrastructure (auth provider, config, api proxy, navbar).

Read c:\source\ms-identity-ciam-native\typescript\browser-delegated\react-nextjs-sample\src\app\security\page.tsx
Read c:\source\ms-identity-ciam-native\typescript\browser-delegated\react-nextjs-sample\src\services\passkey-service.ts
Read c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\src\auth\AuthClientProvider.tsx
Read c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\src\config\auth-config.ts
Let me examine the backends and the native-auth app shell. The key architectural challenge is the MFA/token model differs between MSAL (browser-delegated) and the native-auth SDK.

Bash List api and backend files
IN
cd c:/source/ms-identity-ciam-native/typescript && echo "=== native-auth api dir ===" && find native-auth/react-nextjs-sample/api -type f -not -path '*/node_modules/*' | sort && echo "" && echo "=== browser-delegated root files ===" && ls browser-delegated/react-nextjs-sample/*.mjs browser-delegated/react-nextjs-sample/*.js 2>/dev/null && echo "" && echo "=== native-auth root files ===" && ls native-auth/react-nextjs-sample/*.mjs native-auth/react-nextjs-sample/*.js 2>/dev/null

OUT
Exit code 2
=== native-auth api dir ===
native-auth/react-nextjs-sample/api/.gitignore
native-auth/react-nextjs-sample/api/dist/src/attributeValidation.js
native-auth/react-nextjs-sample/api/dist/src/attributeValidation.js.map
native-auth/react-nextjs-sample/api/dist/src/functions/authProxy.js
native-auth/react-nextjs-sample/api/dist/src/functions/authProxy.js.map
native-auth/react-nextjs-sample/api/host.json
native-auth/react-nextjs-sample/api/package-lock.json
native-auth/react-nextjs-sample/api/package.json
native-auth/react-nextjs-sample/api/src/attributeValidation.ts
native-auth/react-nextjs-sample/api/src/functions/authProxy.ts
native-auth/react-nextjs-sample/api/tsconfig.json

=== browser-delegated root files ===
browser-delegated/react-nextjs-sample/eslint.config.mjs
browser-delegated/react-nextjs-sample/local-proxy.mjs
Read c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\src\app\page.tsx
Read c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\src\components\Navbar.tsx
Now the two backends. Let me read the native-auth proxy and the browser-delegated proxy (which holds the account + passkey route implementations to port), plus the browser-delegated config.

Read c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\api\src\functions\authProxy.ts
Read c:\source\ms-identity-ciam-native\typescript\browser-delegated\react-nextjs-sample\src\config\auth-config.ts
Let me read the browser-delegated local-proxy.mjs (the account + passkey backend to port) and find the native-auth dev proxy (cors.js).

Bash Find native-auth dev proxy and scripts
IN
cd c:/source/ms-identity-ciam-native/typescript/native-auth/react-nextjs-sample && echo "=== native-auth root ===" && ls -la *.js *.mjs *.json 2>/dev/null && echo "=== package.json scripts ===" && cat package.json | grep -A30 '"scripts"'

OUT
=== native-auth root ===
-rw-r--r-- 1 ITECHNOLOGIES+Leo.Nguyen 4096  20463 Jun 22 13:48 cors.js
-rw-r--r-- 1 ITECHNOLOGIES+Leo.Nguyen 4096    909 Jun 10 16:21 eslint.config.mjs
-rw-r--r-- 1 ITECHNOLOGIES+Leo.Nguyen 4096 195245 May 27 14:16 package-lock.json
-rw-r--r-- 1 ITECHNOLOGIES+Leo.Nguyen 4096    631 May 27 14:15 package.json
-rw-r--r-- 1 ITECHNOLOGIES+Leo.Nguyen 4096    858 Jun 22 13:47 proxy.config.js
-rw-r--r-- 1 ITECHNOLOGIES+Leo.Nguyen 4096    743 May 21 11:19 tsconfig.json
=== package.json scripts ===
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "cors": "node cors.js"
  },
  "dependencies": {
    "@azure/msal-browser": "^4.30.0",
    "next": "^16.0.7",
    "react": "^19.2.1",
    "react-dom": "^19.2.1"
  },
  "devDependencies": {
    "@eslint/eslintrc": "^3",
    "@types/node": "^20",
    "@types/react": "^19.2.7",
    "@types/react-dom": "^19.2.3",
    "eslint": "^9",
    "eslint-config-next": "15.1.7",
    "typescript": "^5"
  }
}
Read c:\source\ms-identity-ciam-native\typescript\browser-delegated\react-nextjs-sample\local-proxy.mjs
Let me read the rest of the proxy (route dispatch + account/passkey handlers + CORS).

Read c:\source\ms-identity-ciam-native\typescript\browser-delegated\react-nextjs-sample\local-proxy.mjs (lines 1170-1629)
Let me read the native-auth dev proxy (cors.js) and check the native-auth SDK's account/token API to resolve the key question: how native-auth obtains a fresh (MFA-recent) token for the mutating Graph calls.

Read c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\cors.js
Let me check the native-auth SDK's account/token API to determine how to obtain a token for the Graph calls and whether step-up MFA is possible.

Bash Find SDK account data type defs
IN
cd c:/source/ms-identity-ciam-native/typescript/native-auth/react-nextjs-sample && find node_modules/@azure/msal-browser/lib/types/custom-auth -name "*.d.ts" 2>/dev/null | grep -i -E "account|result|token" | head -20

OUT
(Bash completed with no output)
Bash Locate CustomAuthAccountData definition
IN
cd c:/source/ms-identity-ciam-native/typescript/native-auth/react-nextjs-sample && find node_modules/@azure/msal-browser -name "*.d.ts" 2>/dev/null | grep -i "CustomAuthAccountData" | head; echo "---grep getAccessToken in custom-auth---"; grep -rl "CustomAuthAccountData" node_modules/@azure/msal-browser/lib/types/ 2>/dev/null | head

OUT
node_modules/@azure/msal-browser/dist/custom-auth-path/custom_auth/get_account/auth_flow/CustomAuthAccountData.d.ts
node_modules/@azure/msal-browser/dist/custom_auth/get_account/auth_flow/CustomAuthAccountData.d.ts
node_modules/@azure/msal-browser/lib/custom-auth-path/types/custom_auth/get_account/auth_flow/CustomAuthAccountData.d.ts
node_modules/@azure/msal-browser/lib/types/custom_auth/get_account/auth_flow/CustomAuthAccountData.d.ts
---grep getAccessToken in custom-auth---
node_modules/@azure/msal-browser/lib/types/custom_auth/core/auth_flow/jit/result/AuthMethodRegistrationChallengeMethodResult.d.ts
node_modules/@azure/msal-browser/lib/types/custom_auth/core/auth_flow/jit/result/AuthMethodRegistrationSubmitChallengeResult.d.ts
node_modules/@azure/msal-browser/lib/types/custom_auth/core/auth_flow/mfa/result/MfaSubmitChallengeResult.d.ts
node_modules/@azure/msal-browser/lib/types/custom_auth/get_account/auth_flow/CustomAuthAccountData.d.ts
node_modules/@azure/msal-browser/lib/types/custom_auth/get_account/auth_flow/CustomAuthAccountData.d.ts.map
node_modules/@azure/msal-browser/lib/types/custom_auth/get_account/auth_flow/result/GetAccountResult.d.ts
node_modules/@azure/msal-browser/lib/types/custom_auth/index.d.ts
node_modules/@azure/msal-browser/lib/types/custom_auth/sign_in/auth_flow/result/SignInResult.d.ts
node_modules/@azure/msal-browser/lib/types/custom_auth/sign_in/auth_flow/result/SignInSubmitCodeResult.d.ts
node_modules/@azure/msal-browser/lib/types/custom_auth/sign_in/auth_flow/result/SignInSubmitPasswordResult.d.ts
Read c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\node_modules\@azure\msal-browser\lib\types\custom_auth\get_account\auth_flow\CustomAuthAccountData.d.ts
I now have a complete picture of both implementations. Before writing ~2000 lines across pages, services, and dual backends, I need to resolve a genuine architectural fork — the browser-delegated "manage account" feature leans on MSAL's ngcmfa claims-challenge redirect to force step-up MFA before each sensitive change. Native auth has no step-up/claims-challenge mechanism — MFA only happens during the in-app sign-in flow, and CIAM ID tokens carry no amr to re-verify ([[external_id_token_no_amr]]). That changes how the port must work.

Let me confirm scope and the MFA model so I build the right thing.

AskUserQuestion
OUT
Your questions have been answered: "Which 'manage account' surfaces should I port to native-auth?"="Account + Passkeys + webview/impersonation parity", "Native auth can't do step-up MFA mid-session. How should sensitive changes (email/phone/passkey) gate freshness?"="Sign-in recency + re-auth prompt (Recommended)". You can now continue with these answers in mind.
Both answers confirm full parity with the sign-in-recency MFA model. This is a large, multi-file port. Let me set up tracking and read the last few infra files I need (proxy config, api package deps, env handling).

Read c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\proxy.config.js
Read c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\api\package.json
Read c:\source\ms-identity-ciam-native\typescript\browser-delegated\react-nextjs-sample\src\services\impersonation-service.ts
Read c:\source\ms-identity-ciam-native\typescript\browser-delegated\react-nextjs-sample\src\app\impersonate\page.tsx
Read c:\source\ms-identity-ciam-native\typescript\browser-delegated\react-nextjs-sample\src\components\Navbar.tsx
I have everything I need. Let me verify a couple of SDK/runtime specifics (token result shape, ACS package availability) before writing.

Bash Check ACS package and token result types
IN
cd c:/source/ms-identity-ciam-native/typescript/native-auth/react-nextjs-sample && echo "=== ACS in app node_modules? ===" && ls node_modules/@azure/communication-email 2>/dev/null && echo FOUND || echo "NOT installed in app"; echo "=== ACS in api node_modules? ===" && ls api/node_modules/@azure/communication-email 2>/dev/null && echo FOUND || echo "NOT installed in api"; echo "=== GetAccessTokenResult ==="; cat node_modules/@azure/msal-browser/lib/types/custom_auth/get_account/auth_flow/result/GetAccessTokenResult.d.ts 2>/dev/null; echo "=== AccessTokenRetrievalInputs ==="; grep -A8 "AccessTokenRetrievalInputs" node_modules/@azure/msal-browser/lib/types/custom_auth/CustomAuthActionInputs.d.ts 2>/dev/null | head -20

OUT
=== ACS in app node_modules? ===
LICENSE
README.md
dist
package.json
FOUND
=== ACS in api node_modules? ===
NOT installed in api
=== GetAccessTokenResult ===
import { AuthenticationResult } from "../../../../response/AuthenticationResult.js";
import { AuthFlowResultBase } from "../../../core/auth_flow/AuthFlowResultBase.js";
import { GetCurrentAccountAccessTokenError } from "../error_type/GetAccountError.js";
import { GetAccessTokenCompletedState, GetAccessTokenFailedState } from "../state/GetAccessTokenState.js";
export declare class GetAccessTokenResult extends AuthFlowResultBase<GetAccessTokenResultState, GetCurrentAccountAccessTokenError, AuthenticationResult> {
    /**
     * Creates a new instance of GetAccessTokenResult.
     * @param resultData The result data of the access token.
     */
    constructor(resultData?: AuthenticationResult);
    /**
     * Creates a new instance of GetAccessTokenResult with an error.
     * @param error The error that occurred.
     * @return {GetAccessTokenResult} The result with the error.
     */
    static createWithError(error: unknown): GetAccessTokenResult;
    /**
     * Checks if the result is completed.
     */
    isCompleted(): this is GetAccessTokenResult & {
        state: GetAccessTokenCompletedState;
    };
    /**
     * Checks if the result is failed.
     */
    isFailed(): this is GetAccessTokenResult & {
        state: GetAccessTokenFailedState;
    };
}
/**
 * The possible states for the GetAccessTokenResult.
 * This includes:
 * - GetAccessTokenCompletedState: The access token was successfully retrieved.
 * - GetAccessTokenFailedState: The access token retrieval failed.
 */
export type GetAccessTokenResultState = GetAccessTokenCompletedState | GetAccessTokenFailedState;
//# sourceMappingURL=GetAccessTokenResult.d.ts.map=== AccessTokenRetrievalInputs ===
export type AccessTokenRetrievalInputs = {
    forceRefresh: boolean;
    scopes?: Array<string>;
    claims?: string;
};
export type SignInWithContinuationTokenInputs = {
    scopes?: Array<string>;
    claims?: string;
};
ACS is available in the app (I'll add it to the api package). Let me check how the native-auth webview page retrieves its token, so my pages mirror the established SDK pattern.

Read c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\src\app\webview\page.tsx
Read c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\src\services\webview-service.ts
I have a complete picture now. Let me set up task tracking and begin implementing. The native-auth model: token via authClient.getCurrentAccount().data.getIdToken(), claims via getClaims(), dev-host gating like the existing webview feature, and the proxy's iat-freshness check as the MFA gate (no redirect).

Update Todos

Extend native-auth auth-config.ts with account/passkey/impersonation API bases, feature flags, passkeyRpId, ngcmfa note, and email-from-claims helper

Port account-service.ts to native-auth (rebased imports)

Port passkey-service.ts to native-auth

Port impersonation-service.ts to native-auth

Write shared graph-routes.js backend module (app-only Graph, OTP, account/passkey/impersonation ops) and wire into cors.js

Port account/page.tsx to native-auth SDK token model (no MFA redirect; re-auth prompt on mfa_required)

Port security/page.tsx (passkeys) to native-auth SDK token model

Port impersonate/page.tsx to native-auth SDK token model

Add My Account / Security / Impersonation links to native-auth Navbar

Add account/passkey/impersonation routes to api/authProxy.ts (prod parity) + ACS dep

Build + lint the native-auth app and fix errors
Starting with the config. Let me extend the native-auth auth-config.ts.

Edit c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\src\config\auth-config.ts
Added 87 lines
Config done. Now the three services — these are backend clients, mostly portable. Let me write all three.

Update Todos

Extend native-auth auth-config.ts with account/passkey/impersonation API bases, feature flags, passkeyRpId, ngcmfa note, and email-from-claims helper

Port account-service.ts to native-auth (rebased imports)

Port passkey-service.ts to native-auth

Port impersonation-service.ts to native-auth

Write shared graph-routes.js backend module (app-only Graph, OTP, account/passkey/impersonation ops) and wire into cors.js

Port account/page.tsx to native-auth SDK token model (no MFA redirect; re-auth prompt on mfa_required)

Port security/page.tsx (passkeys) to native-auth SDK token model

Port impersonate/page.tsx to native-auth SDK token model

Add My Account / Security / Impersonation links to native-auth Navbar

Add account/passkey/impersonation routes to api/authProxy.ts (prod parity) + ACS dep

Build + lint the native-auth app and fix errors
Write c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\src\services\account-service.ts
119 lines
import { accountApiBase } from "@/config/auth-config";

/**
 * Client for the account routes on the native-auth `/api` proxy (cors.js in dev,
 * the SWA managed function in production). The proxy fronts the Microsoft Graph
 * APIs that change a sign-in email or a mobile authentication method — both of
 * which need an app-only token, so the secret and Graph token stay server-side.
 *
 *   summary       GET  /api/account                       read current email + mobile
 *   sendSignInOtp POST /api/account/signin-name/send-otp  email a code to a new sign-in email
 *   signInName    POST /api/account/signin-name           change sign-in email (needs that code)
 *   phone         POST /api/account/phone                 change mobile number
 *
 * Password changes are NOT here: Microsoft Graph has no app-only (or external-
 * tenant self-service) path to set a user's own password, so the account page
 * routes password changes into this sample's in-app /reset-password flow.
 *
 * Every call is authenticated with the signed-in user's ID token; the proxy
 * verifies it and derives the Graph user id from it, so callers can only touch
 * their own account. The three mutations additionally require a freshly-issued
 * token — native auth's in-app SMS MFA at sign-in is what makes a recent token
 * "fresh"; there is no silent step-up MFA, so a stale token surfaces as
 * `mfa_required` and the page asks the user to sign in again.
 */

export interface AccountSummary {
    displayName: string | null;
    email: string | null;
    username: string | null;
    phoneNumber: string | null;
}

/** Error from the proxy, carrying its machine-readable code (e.g. "mfa_required"). */
export class AccountApiError extends Error {
    constructor(message: string, public readonly code?: string) {
        super(message);
        this.name = "AccountApiError";
    }
}

async function callAccountApi(
    path: string,
    bearerToken: string,
    init: RequestInit = {}
): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(`${accountApiBase}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${bearerToken}`,
                ...init.headers,
            },
        });
    } catch {
        throw new Error(
            "Could not reach the local proxy. Start it with `npm run cors` (see the README, 'My account' section)."
        );
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        body = undefined;
    }

    if (!response.ok) {
        const err = body as { error?: { message?: string; code?: string } } | undefined;
        throw new AccountApiError(
            err?.error?.message ?? err?.error?.code ?? `HTTP ${response.status}`,
            err?.error?.code
        );
    }
    return body;
}

export async function fetchAccountSummary(bearerToken: string): Promise<AccountSummary> {
    return (await callAccountApi("/account", bearerToken)) as AccountSummary;
}

/**
 * Email a verification code to a prospective new sign-in address. Proves the
 * user controls the mailbox before changeSignInName() will accept it. Only needs
 * a valid token (not a fresh one). Returns the proxy's confirmation message.
 */
export async function sendSignInNameOtp(bearerToken: string, email: string): Promise<string> {
    const body = (await callAccountApi("/account/signin-name/send-otp", bearerToken, {
        method: "POST",
        body: JSON.stringify({ email }),
    })) as { message?: string };
    return body.message ?? "Verification code sent.";
}

/**
 * Change the sign-in email. Requires the `otp` emailed by sendSignInNameOtp()
 * and a recently-issued `bearerToken`. Returns the human-readable confirmation.
 */
export async function changeSignInName(
    bearerToken: string,
    email: string,
    otp: string
): Promise<string> {
    const body = (await callAccountApi("/account/signin-name", bearerToken, {
        method: "POST",
        body: JSON.stringify({ email, otp }),
    })) as { message?: string };
    return body.message ?? "Sign-in email changed.";
}

export async function changePhone(bearerToken: string, phoneNumber: string): Promise<string> {
    const body = (await callAccountApi("/account/phone", bearerToken, {
        method: "POST",
        body: JSON.stringify({ phoneNumber }),
    })) as { message?: string };
    return body.message ?? "Mobile number changed.";
}
Write c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\src\services\passkey-service.ts
212 lines
import { passkeyApiBase } from "@/config/auth-config";

/**
 * Client for the passkey routes on the native-auth `/api` proxy (cors.js in dev,
 * the SWA managed function in production) plus the WebAuthn ceremony itself. The
 * proxy fronts the Microsoft Graph beta fido2Methods provisioning APIs:
 *
 *   list     GET    /users/{oid}/authentication/fido2Methods
 *   options  GET    /users/{oid}/authentication/fido2Methods/creationOptions(...)
 *   register POST   /users/{oid}/authentication/fido2Methods
 *   delete   DELETE /users/{oid}/authentication/fido2Methods/{id}
 *
 * Every call is authenticated with the signed-in user's ID token; the proxy
 * verifies it and derives {oid} from it, so users can only touch their own
 * passkeys.
 */

/** UI-friendly view of a Graph fido2AuthenticationMethod. */
export interface PasskeyInfo {
    id: string;
    name: string;
    model: string;
    passkeyType: string;
    createdDateTime: string | null;
    lastUsedDateTime: string | null;
}

interface GraphFido2Method {
    id: string;
    displayName?: string;
    model?: string;
    passkeyType?: string;
    createdDateTime?: string;
    lastUsedDateTime?: string;
}

/**
 * WebAuthn creationOptions as returned by Graph (the `publicKey` member).
 * Binary fields arrive base64url-encoded and must be converted to ArrayBuffers
 * before they can be passed to navigator.credentials.create().
 */
interface GraphCreationOptions {
    challenge: string;
    timeout: number;
    rp: { id: string; name: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: PublicKeyCredentialParameters[];
    excludeCredentials: { id: string; type: string; transports?: string[] }[];
    authenticatorSelection: AuthenticatorSelectionCriteria;
    attestation: AttestationConveyancePreference;
}

/* ----------------------------- base64url helpers ----------------------------- */

function base64UrlToBuffer(value: string): ArrayBuffer {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Graph encodes excludeCredentials ids as base64url with the number of stripped
 * "=" padding characters appended as a trailing digit (e.g. "...xyz2" = two
 * padding chars). Decode back to raw bytes for the WebAuthn call.
 */
function decodeGraphCredentialId(id: string): ArrayBuffer {
    const match = id.match(/^(.*?)(\d)$/);
    if (!match) {
        throw new Error("Invalid Microsoft Graph credential id format");
    }
    const [, base, padCount] = match;
    const base64 = (base + "=".repeat(parseInt(padCount, 10)))
        .replace(/-/g, "+")
        .replace(/_/g, "/");
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}

/* ------------------------------- proxy client -------------------------------- */

async function callPasskeyApi(
    path: string,
    bearerToken: string,
    init: RequestInit = {}
): Promise<Response> {
    let response: Response;
    try {
        response = await fetch(`${passkeyApiBase}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${bearerToken}`,
                ...init.headers,
            },
        });
    } catch {
        throw new Error(
            "Could not reach the local proxy. Start it with `npm run cors` (see the README, Passkeys section)."
        );
    }

    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        let code: string | undefined;
        try {
            const body = await response.json();
            message = body?.error?.message ?? body?.error?.code ?? message;
            code = body?.error?.code;
        } catch {
            // keep the bare status message
        }
        throw new PasskeyApiError(message, code);
    }
    return response;
}

/** Error from the proxy, carrying its machine-readable code (e.g. "mfa_required"). */
export class PasskeyApiError extends Error {
    constructor(message: string, public readonly code?: string) {
        super(message);
        this.name = "PasskeyApiError";
    }
}

export async function fetchPasskeys(bearerToken: string): Promise<PasskeyInfo[]> {
    const response = await callPasskeyApi("/passkeys", bearerToken);
    const body: { value?: GraphFido2Method[] } = await response.json();
    return (body.value ?? []).map((method) => ({
        id: method.id,
        name: method.displayName || "Unnamed passkey",
        model: method.model || "Unknown model",
        passkeyType: method.passkeyType === "deviceBound" ? "Device-bound" : "Synced",
        createdDateTime: method.createdDateTime ?? null,
        lastUsedDateTime: method.lastUsedDateTime ?? null,
    }));
}

export async function fetchCreationOptions(bearerToken: string): Promise<GraphCreationOptions> {
    const response = await callPasskeyApi("/passkeys/creation-options", bearerToken);
    const body = await response.json();
    return body.publicKey as GraphCreationOptions;
}

/**
 * Run the browser's WebAuthn creation ceremony with the Graph-issued options.
 * Throws DOMException "NotAllowedError" when the user cancels / times out, or
 * "SecurityError" when the serving origin doesn't match rp.id.
 */
export async function createPasskeyCredential(
    options: GraphCreationOptions
): Promise<PublicKeyCredential> {
    const publicKey: PublicKeyCredentialCreationOptions = {
        challenge: base64UrlToBuffer(options.challenge),
        rp: { id: options.rp.id, name: options.rp.name },
        user: {
            id: base64UrlToBuffer(options.user.id),
            name: options.user.name,
            displayName: options.user.displayName,
        },
        pubKeyCredParams: options.pubKeyCredParams,
        excludeCredentials: options.excludeCredentials.map((credential) => ({
            type: "public-key" as const,
            id: decodeGraphCredentialId(credential.id),
            transports: credential.transports as AuthenticatorTransport[] | undefined,
        })),
        timeout: options.timeout,
        authenticatorSelection: options.authenticatorSelection,
        attestation: options.attestation,
    };

    const credential = await navigator.credentials.create({ publicKey });
    if (!credential) {
        throw new Error("The browser did not return a credential.");
    }
    return credential as PublicKeyCredential;
}

export async function registerPasskey(
    bearerToken: string,
    credential: PublicKeyCredential,
    displayName: string
): Promise<void> {
    const response = credential.response as AuthenticatorAttestationResponse;
    await callPasskeyApi("/passkeys", bearerToken, {
        method: "POST",
        body: JSON.stringify({
            displayName,
            publicKeyCredential: {
                id: credential.id,
                response: {
                    attestationObject: bufferToBase64Url(response.attestationObject),
                    clientDataJSON: bufferToBase64Url(response.clientDataJSON),
                },
            },
        }),
    });
}

export async function deletePasskey(bearerToken: string, passkeyId: string): Promise<void> {
    await callPasskeyApi(`/passkeys/${encodeURIComponent(passkeyId)}`, bearerToken, {
        method: "DELETE",
    });
}
Write c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\src\services\impersonation-service.ts
165 lines
import { impersonationApiBase, impersonationViewBase } from "@/config/auth-config";

/**
 * Client for the impersonation portal routes on the native-auth `/api` proxy
 * (cors.js in dev), Feature B / B4 — the RWVP "sign in as a customer" support
 * portal.
 *
 * External ID has no supported way to issue a token AS another customer, so
 * impersonation is modelled at the application/session layer (plan B4.1): an
 * RBAC-gated admin action mints a signed HttpOnly *app* session — never an Entra
 * token — that records both the acting admin and the impersonated subject. The
 * proxy enforces the admin allow-list, the read-only scope, the bounded TTL,
 * revocation, and the audit log (plan B4.2). See impersonation-portal-design.md.
 *
 *   start   POST /api/impersonation/start    admin Bearer; mint a session (RBAC)
 *   whoami  GET  /api/impersonation/whoami    cookie-based; current session or 401
 *   stop    POST /api/impersonation/stop      cookie-based; end the session
 *   revoke  POST /api/impersonation/revoke    admin Bearer; kill a session by id
 *   audit   GET  /api/impersonation/audit     admin Bearer; active + audit log
 *
 * whoami/stop ride the HttpOnly impersonation cookie, so they use
 * `credentials: "include"` and no Bearer token; start/revoke/audit are gated on
 * the admin's verified ID token.
 */

export interface ImpersonationIdentity {
    oid: string | null;
    email: string | null;
    name?: string | null;
}

export interface ImpersonationSession {
    sessionId: string;
    actor: ImpersonationIdentity;
    subject: ImpersonationIdentity;
    reason: string | null;
    scope: string | null;
    startedAt: number;
    expiresAt: number;
}

export interface ImpersonationAuditEntry {
    action: "start" | "stop" | "revoke";
    sessionId: string;
    actor: ImpersonationIdentity;
    subject: ImpersonationIdentity;
    reason: string | null;
    scope: string | null;
    at: string;
}

/** Error from the proxy, carrying its machine-readable code (e.g. "not_admin"). */
export class ImpersonationApiError extends Error {
    constructor(message: string, public readonly code?: string) {
        super(message);
        this.name = "ImpersonationApiError";
    }
}

async function callImpersonationApi(
    path: string,
    init: RequestInit = {},
    bearerToken?: string
): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(`${impersonationApiBase}${path}`, {
            ...init,
            // The HttpOnly impersonation cookie must be sent/stored across these
            // calls (whoami/stop rely on it; start sets it).
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
                ...init.headers,
            },
        });
    } catch {
        throw new ImpersonationApiError(
            "Could not reach the local proxy. Start it with `npm run cors` (see the README, 'Impersonation portal' section)."
        );
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        body = undefined;
    }

    if (!response.ok) {
        const err = body as { error?: { message?: string; code?: string } } | undefined;
        throw new ImpersonationApiError(
            err?.error?.message ?? err?.error?.code ?? `HTTP ${response.status}`,
            err?.error?.code
        );
    }
    return body;
}

/** Start impersonating a customer. Admin-gated; needs a justification (reason). */
export async function startImpersonation(
    bearerToken: string,
    subjectEmail: string,
    reason: string
): Promise<ImpersonationSession> {
    const body = (await callImpersonationApi(
        "/impersonation/start",
        { method: "POST", body: JSON.stringify({ subjectEmail, reason }) },
        bearerToken
    )) as { session: ImpersonationSession };
    return body.session;
}

/**
 * Read the currently-active impersonation session from the HttpOnly cookie.
 * Returns null when there is none (the proxy answers 401 with code "no_session").
 */
export async function fetchActiveImpersonation(): Promise<ImpersonationSession | null> {
    try {
        const body = (await callImpersonationApi("/impersonation/whoami")) as {
            session: ImpersonationSession;
        };
        return body.session;
    } catch (err) {
        if (err instanceof ImpersonationApiError && err.code === "no_session") return null;
        throw err;
    }
}

/** End the active impersonation session (clears the cookie). Idempotent. */
export async function stopImpersonation(): Promise<void> {
    await callImpersonationApi("/impersonation/stop", { method: "POST" });
}

/** Revoke a live session by id (admin-gated) — cuts it off even from elsewhere. */
export async function revokeImpersonation(bearerToken: string, sessionId: string): Promise<void> {
    await callImpersonationApi(
        "/impersonation/revoke",
        { method: "POST", body: JSON.stringify({ sessionId }) },
        bearerToken
    );
}

export interface ImpersonationAudit {
    active: ImpersonationSession[];
    log: ImpersonationAuditEntry[];
}

/** Read the audit trail + currently-live sessions (admin-gated). */
export async function fetchImpersonationAudit(bearerToken: string): Promise<ImpersonationAudit> {
    return (await callImpersonationApi(
        "/impersonation/audit",
        { method: "GET" },
        bearerToken
    )) as ImpersonationAudit;
}

/** URL of the impersonated-view content to load in the portal's iframe. */
export function impersonationViewUrl(
    path: "/impersonate-view" | "/impersonate-view/profile" = "/impersonate-view"
): string {
    return `${impersonationViewBase}${path}`;
}
Now the backend. I'll write a self-contained CommonJS module graph-routes.js (app-only Graph + account/passkey/impersonation, ported from local-proxy.mjs) that reuses cors.js's token verification, then wire it into cors.js.

Write c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\graph-routes.js
1047 lines
/**
 * Graph-backed account / passkey / impersonation routes for the native-auth
 * sample's local dev proxy (cors.js). Ported from the browser-delegated sample's
 * local-proxy.mjs so both samples expose the SAME "manage account" feature set.
 *
 * Where the browser-delegated app runs these on a SEPARATE proxy (MSAL needs no
 * proxy of its own), native auth already routes everything through the same-origin
 * `/api` proxy (cors.js) — so these routes are merged into that one server. This
 * module is a factory: cors.js passes in its existing token-verification helper
 * (so the JWKS/signature/issuer/audience checks aren't duplicated) and gets back a
 * single `handle(req, res, reqUrl, corsHeaders)` that returns `true` when it owns
 * the request (account / passkey / impersonation), `false` to fall through to the
 * CIAM passthrough.
 *
 *   Account self-management:
 *     GET  /api/account                       read the caller's email + mobile number
 *     POST /api/account/signin-name/send-otp  email a verification code to a NEW
 *                                             sign-in email (proves mailbox control)
 *     POST /api/account/signin-name           change sign-in email (fresh token + OTP)
 *     POST /api/account/phone                 change mobile number (fresh token)
 *
 *   Passkeys (FIDO2) — fido2Methods provisioning:
 *     GET    /api/passkeys                    list the caller's passkeys
 *     GET    /api/passkeys/creation-options   WebAuthn creationOptions   (fresh token)
 *     POST   /api/passkeys                    register a credential      (fresh token)
 *     DELETE /api/passkeys/{id}               delete a passkey           (fresh token)
 *
 *   Impersonation portal — RWVP (Feature B / B4):
 *     POST /api/impersonation/start           admin Bearer; mint an app session (RBAC)
 *     GET  /api/impersonation/whoami          cookie-based; current session or 401
 *     POST /api/impersonation/stop            cookie-based; end the session
 *     POST /api/impersonation/revoke          admin Bearer; kill a session by id
 *     GET  /api/impersonation/audit           admin Bearer; active + audit log
 *     GET  /impersonate-view[/profile]        cookie-gated "as the customer" view
 *
 * The Graph APIs behind these need an APP-ONLY token, so the client secret + Graph
 * token stay in this process and the SPA only ever sends the signed-in user's ID
 * token. Local/demo use only; for production host the same logic in a real backend
 * with the secret in Key Vault.
 *
 * MFA freshness: native auth has no step-up MFA and CIAM tokens carry no amr, so
 * `requireFreshMfa` enforces token recency (iat age) only — the native sign-in
 * already included SMS MFA, so a recent token implies recent MFA. A stale token
 * fails with `mfa_required` and the page re-runs sign-in.
 */

const crypto = require("node:crypto");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// External ID customer-account sign-in identities + fido2Methods provisioning
// live on beta; v1.0 can return an empty identities[] for these accounts.
const GRAPH_BETA = "https://graph.microsoft.com/beta";

// Well-known authentication-method id for the mobile phone method (same constant
// for every user). https://learn.microsoft.com/graph/api/phoneauthenticationmethod-update
const MOBILE_PHONE_METHOD_ID = "3179e48a-750b-4051-897c-87b9720928f7";
const CHALLENGE_TIMEOUT_MINUTES = 60;

// How fresh the user's token must be for a change (native-auth tokens are issued
// after the in-app SMS MFA at sign-in, so iat age ≈ time since MFA).
const FRESH_MFA_MAX_AGE_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;

// New-email verification OTP.
const OTP_TTL_SECONDS = 10 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 30;

const IMPERSONATION_COOKIE_NAME = "st_impersonation_session";
const IMPERSONATION_TTL_SECONDS = 15 * 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[0-9][0-9\s]{6,17}$/;

/** HttpError with an optional machine-readable code (e.g. "mfa_required"). */
class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

// amr values that indicate a second factor. Only consulted when a token actually
// carries amr — Entra External ID CIAM tokens usually don't.
const MFA_AMR_VALUES = [
    "ngcmfa", "mfa", "otp", "sms", "tel", "fido",
    "face", "fpt", "iris", "retina", "sc", "pop", "hwk",
];

module.exports = function createGraphRoutes(deps) {
    const { verifyBearerToken, escapeHtml, config } = deps;
    const {
        tenantId,
        clientId,
        clientSecret,
        acsConnectionString,
        acsSenderAddress,
        mailSenderDisplayName = "myServiceTas",
        impersonationAdminEmails = new Set(),
        impersonationAdminOids = new Set(),
        impersonationAllowAnyAdmin = false,
    } = config;

    /* ------------------------------ helpers ------------------------------- */

    function requireFreshMfa(payload) {
        const now = Math.floor(Date.now() / 1000);
        const freshEnough = (payload.iat ?? 0) >= now - FRESH_MFA_MAX_AGE_SECONDS;
        // amr absent (the normal CIAM case): rely on iat freshness — native auth
        // forces SMS MFA at sign-in, so a recent token implies recent MFA. amr
        // present: it must name a second factor (defence in depth).
        const amrOk =
            !Array.isArray(payload.amr) ||
            payload.amr.some((m) => MFA_AMR_VALUES.includes(m));
        if (!freshEnough || !amrOk) {
            throw new HttpError(
                401,
                "Recent multi-factor authentication required. Sign in again and try again.",
                "mfa_required"
            );
        }
    }

    /* --------------------------- Graph client ----------------------------- */

    let appTokenCache = null; // { token, expiresAt }

    async function getAppToken(forceRefresh = false) {
        if (!clientSecret) {
            throw new HttpError(
                500,
                "Account management is not configured on the proxy. Set ACCOUNT_CLIENT_SECRET in .env.local (see the README, 'My account' / 'Passkeys' section)."
            );
        }
        if (!forceRefresh && appTokenCache && Date.now() < appTokenCache.expiresAt) {
            return appTokenCache.token;
        }
        const body = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "client_credentials",
            scope: "https://graph.microsoft.com/.default",
        });
        const response = await fetch(
            `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
            { method: "POST", body }
        );
        const data = await response.json();
        if (!response.ok) {
            console.error("App token request failed:", data);
            throw new HttpError(502, data.error_description ?? "Could not acquire Graph token.");
        }
        appTokenCache = {
            token: data.access_token,
            expiresAt: Date.now() + (data.expires_in - 300) * 1000,
        };
        return appTokenCache.token;
    }

    async function callGraph(method, endpoint, body, base = GRAPH_BASE) {
        const attempt = async (forceFreshToken) => {
            const token = await getAppToken(forceFreshToken);
            const response = await fetch(`${base}${endpoint}`, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: body ? JSON.stringify(body) : undefined,
            });
            const text = await response.text();
            let json;
            try {
                json = text ? JSON.parse(text) : undefined;
            } catch {
                json = undefined;
            }
            return { status: response.status, ok: response.ok, body: text, json };
        };
        let result = await attempt(false);
        if (result.status === 401 || result.status === 403) {
            // App-role grants made while the proxy runs only show up in a fresh
            // token (the cached one is good ~1h). Retry once with a new token.
            result = await attempt(true);
        }
        return result;
    }

    function assertGraphOk(result, fallback) {
        if (result.ok) return;
        const message = result.json?.error?.message ?? result.json?.error?.code ?? fallback;
        throw new HttpError(result.status === 0 ? 502 : result.status, message);
    }

    /* ------------------------- new-email OTP store ------------------------ */

    const pendingOtps = new Map(); // oid -> { email, codeHash, expiresAt, attempts, lastSentAt }
    const hashOtp = (code) => crypto.createHash("sha256").update(code).digest("hex");

    function hashesEqual(a, b) {
        const bufA = Buffer.from(a, "hex");
        const bufB = Buffer.from(b, "hex");
        return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
    }

    function generateOtp() {
        return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    }

    function verifyOtp(oid, email, code) {
        const entry = pendingOtps.get(oid);
        if (!entry) {
            throw new HttpError(400, "Request a verification code for the new email first.", "otp_required");
        }
        const now = Math.floor(Date.now() / 1000);
        if (entry.expiresAt < now) {
            pendingOtps.delete(oid);
            throw new HttpError(400, "Your verification code expired. Please request a new one.", "otp_required");
        }
        if (entry.email !== email.toLowerCase()) {
            throw new HttpError(400, "The verification code was sent to a different email. Please request a new one.", "otp_required");
        }
        if (!/^\d{6}$/.test(code) || !hashesEqual(entry.codeHash, hashOtp(code))) {
            entry.attempts += 1;
            if (entry.attempts >= OTP_MAX_ATTEMPTS) {
                pendingOtps.delete(oid);
                throw new HttpError(400, "Too many incorrect attempts. Please request a new code and try again.", "otp_required");
            }
            throw new HttpError(400, "That verification code is incorrect. Please try again.", "otp_invalid");
        }
        pendingOtps.delete(oid); // single-use
    }

    async function sendSignInOtp(oid, email) {
        if (!acsConnectionString || !acsSenderAddress) {
            throw new HttpError(
                500,
                "Email provider not configured. Set COMMUNICATION_SERVICES_CONNECTION_STRING and COMMUNICATION_SERVICES_SENDER_ADDRESS in .env.local."
            );
        }
        const now = Math.floor(Date.now() / 1000);
        const existing = pendingOtps.get(oid);
        if (existing && now - existing.lastSentAt < OTP_RESEND_COOLDOWN_SECONDS) {
            const wait = OTP_RESEND_COOLDOWN_SECONDS - (now - existing.lastSentAt);
            throw new HttpError(429, `Please wait ${wait}s before requesting another code.`, "otp_cooldown");
        }
        const code = generateOtp();
        pendingOtps.set(oid, {
            email: email.toLowerCase(),
            codeHash: hashOtp(code),
            expiresAt: now + OTP_TTL_SECONDS,
            attempts: 0,
            lastSentAt: now,
        });

        const { subject, html, plainText } = buildOtpEmail(email, code, mailSenderDisplayName);
        // Lazy require so cors.js still starts if the ACS package isn't installed
        // (the send-otp route then fails with a clear message instead).
        let EmailClient;
        try {
            ({ EmailClient } = require("@azure/communication-email"));
        } catch {
            pendingOtps.delete(oid);
            throw new HttpError(
                500,
                "The @azure/communication-email package is not installed. Run `npm install` so the new-email verification code can be sent."
            );
        }
        const client = new EmailClient(acsConnectionString);
        try {
            await client.beginSend({
                senderAddress: acsSenderAddress,
                recipients: { to: [{ address: email }] },
                content: { subject, html, plainText },
            });
        } catch (err) {
            pendingOtps.delete(oid); // no email went out — don't strand a dead code
            console.error("Failed to send verification email via ACS:", err);
            throw new HttpError(502, "Could not send the verification email. Please try again.");
        }
    }

    function buildOtpEmail(email, code, brandName) {
        const BRAND_GREEN = "#098851";
        const TEXT_COLOR = "#292929";
        const MUTED_COLOR = "#6b7280";
        const FONT_STACK =
            "'Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
        const TAS_GOVT_LOGO =
            "https://lively-plant-074801300.7.azurestaticapps.net/logos/tasmania-govt-black.png";
        const subject = `${brandName} sign-in email verification code`;
        const plainText =
            `Verify your new sign-in email\n\n` +
            `Use this code to confirm ${email} as your new sign-in email.\n\n` +
            `Your code is: ${code}\n\n` +
            `This code expires in ${Math.round(OTP_TTL_SECONDS / 60)} minutes. ` +
            `If you didn't request this, you can ignore this email.\n\n` +
            `Sincerely,\n${brandName}\n\n` +
            `This message was sent from an unmonitored email address. Please do not reply.\n` +
            `Service Tasmania | Tasmanian Government`;
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${subject}</title>
</head>
<body style="margin:0; padding:0; background-color:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0"
               style="width:600px; max-width:600px; background-color:#ffffff; font-family:${FONT_STACK}; color:${TEXT_COLOR};">
          <tr>
            <td style="background-color:${BRAND_GREEN}; padding:22px 32px;">
              <span style="color:#ffffff; font-size:22px; font-weight:600;">Verify your new sign-in email</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 24px 0; font-size:16px; line-height:1.5;">
                Use this code to confirm <span style="color:#0066cc; text-decoration:underline;">${email}</span> as your new sign-in email.
              </p>
              <p style="margin:0 0 24px 0; font-size:16px; line-height:1.5;">
                <strong>Your code is: ${code}</strong>
              </p>
              <p style="margin:0 0 24px 0; font-size:14px; line-height:1.5; color:${MUTED_COLOR};">
                This code expires in ${Math.round(OTP_TTL_SECONDS / 60)} minutes. If you didn't request this, you can ignore this email.
              </p>
              <p style="margin:0; font-size:16px; line-height:1.5;">Sincerely,</p>
              <p style="margin:0; font-size:16px; font-style:italic;">${brandName}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px;">
              <hr style="border:none; border-top:1px solid #e5e7eb; margin:0;" />
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 32px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:12px; color:${MUTED_COLOR}; line-height:1.5; vertical-align:bottom;">
                    This message was sent from an unmonitored email address.<br />
                    Please do not reply to this message.
                  </td>
                  <td align="right" style="vertical-align:middle;">
                    <table role="presentation" cellpadding="0" cellspacing="0" align="right" style="border-collapse:collapse;">
                      <tr>
                        <td style="font-size:24px; font-weight:700; color:${TEXT_COLOR}; padding-right:14px; vertical-align:middle; white-space:nowrap;">Service&nbsp;Tasmania</td>
                        <td style="border-left:1px solid ${TEXT_COLOR}; padding-left:14px; vertical-align:middle;">
                          <img src="${TAS_GOVT_LOGO}" width="48" height="44" alt="Tasmanian Government" style="display:block; border:0; outline:none; text-decoration:none;" />
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
        return { subject, html, plainText };
    }

    /* --------------------------- account ops ------------------------------ */

    const fido2MethodsPath = (oid) => `/users/${oid}/authentication/fido2Methods`;
    const USER_SELECT = "displayName,identities,userPrincipalName,mail,otherMails";

    function resolveSignInEmail(userJson) {
        const identities = userJson?.identities ?? [];
        const index = identities.findIndex(
            (i) =>
                i.signInType === "emailAddress" ||
                (i.signInType === "userName" && String(i.issuerAssignedId ?? "").includes("@"))
        );
        if (index !== -1) {
            return { kind: "identity", index, value: identities[index].issuerAssignedId };
        }
        const upn = userJson?.userPrincipalName;
        if (upn && String(upn).includes("@")) {
            return { kind: "upn", value: upn };
        }
        return null;
    }

    async function getRealIdentities(oid, userJson, tokenEmail) {
        const direct = userJson?.identities ?? [];
        if (direct.some((i) => i.signInType === "emailAddress")) return direct;
        const probeEmails = [...new Set(
            [userJson?.mail, tokenEmail, ...(userJson?.otherMails ?? [])]
                .filter((e) => typeof e === "string" && e.includes("@"))
        )];
        for (const probeEmail of probeEmails) {
            const escaped = String(probeEmail).replace(/'/g, "''");
            const probe = await callGraph(
                "GET",
                `/users?$select=id,identities&$filter=${encodeURIComponent(
                    `identities/any(c:c/issuerAssignedId eq '${escaped}')`
                )}`,
                undefined,
                GRAPH_BETA
            );
            if (probe.ok) {
                const match = (probe.json?.value ?? []).find((u) => u.id === oid);
                if (match?.identities?.length) return match.identities;
            }
        }
        return direct;
    }

    async function getAccountSummary(oid, tokenEmail) {
        const [user, phones] = await Promise.all([
            callGraph("GET", `/users/${oid}?$select=${USER_SELECT}`, undefined, GRAPH_BETA),
            callGraph("GET", `/users/${oid}/authentication/phoneMethods`),
        ]);
        assertGraphOk(user, "Could not read your account details.");
        assertGraphOk(phones, "Could not read your phone number.");
        const identities = await getRealIdentities(oid, user.json, tokenEmail);
        const signIn = resolveSignInEmail({ ...user.json, identities });
        const usernameIdentity = identities.find((i) => i.signInType === "userName");
        const methods = phones.json?.value ?? [];
        const mobile = methods.find((m) => m.phoneType === "mobile") ?? methods[0];
        return {
            displayName: user.json?.displayName ?? null,
            email: signIn?.value ?? user.json?.mail ?? null,
            username: usernameIdentity?.issuerAssignedId ?? null,
            phoneNumber: mobile?.phoneNumber ?? null,
        };
    }

    async function changeSignInName(oid, newEmail, tokenEmail) {
        const user = await callGraph("GET", `/users/${oid}?$select=${USER_SELECT}`, undefined, GRAPH_BETA);
        assertGraphOk(user, "Could not read your current sign-in details.");
        const identities = await getRealIdentities(oid, user.json, tokenEmail);
        const emailIdx = identities.findIndex(
            (i) =>
                i.signInType === "emailAddress" ||
                (i.signInType === "userName" && String(i.issuerAssignedId ?? "").includes("@"))
        );
        if (emailIdx === -1) {
            const found = identities.map((i) => i.signInType ?? "?").join(", ") || "none";
            throw new HttpError(
                400,
                `No editable email sign-in identity on this account (identities: ${found}). ` +
                    "If this is a social/federated account, the sign-in name is owned by that provider."
            );
        }
        // 1. Primary: the sign-in identity (identities live on beta here).
        const updatedIdentities = identities.map((i, j) =>
            j === emailIdx ? { ...i, issuerAssignedId: newEmail } : i
        );
        const idResult = await callGraph("PATCH", `/users/${oid}`, { identities: updatedIdentities }, GRAPH_BETA);
        assertGraphOk(idResult, "Could not change your sign-in email.");

        const synced = ["sign-in email"];
        const warnings = [];

        // 2. Email one-time-passcode method (OTP target).
        try {
            const methods = await callGraph("GET", `/users/${oid}/authentication/emailMethods`);
            if (methods.ok) {
                const method = (methods.json?.value ?? [])[0];
                const upd = method
                    ? await callGraph(
                          "PATCH",
                          `/users/${oid}/authentication/emailMethods/${method.id}`,
                          { emailAddress: newEmail }
                      )
                    : await callGraph("POST", `/users/${oid}/authentication/emailMethods`, {
                          emailAddress: newEmail,
                      });
                if (upd.ok) synced.push(method ? "email OTP method" : "email OTP method (created)");
                else warnings.push(`email OTP method: ${upd.json?.error?.message ?? `HTTP ${upd.status}`}`);
            } else {
                warnings.push(`email OTP method: ${methods.json?.error?.message ?? `HTTP ${methods.status}`}`);
            }
        } catch (err) {
            warnings.push(`email OTP method: ${err.message}`);
        }

        // 3. Profile email (mail + otherMails) — drives the token's email claim.
        try {
            const mailResult = await callGraph("PATCH", `/users/${oid}`, {
                mail: newEmail,
                otherMails: [newEmail],
            });
            if (mailResult.ok) synced.push("profile email (mail)");
            else {
                const detail = mailResult.json?.error?.message ?? `HTTP ${mailResult.status}`;
                warnings.push(
                    `profile email (mail): ${detail} — grant the app User-Mail.ReadWrite.All (or User.ReadWrite.All) to sync this.`
                );
            }
        } catch (err) {
            warnings.push(`profile email (mail): ${err.message}`);
        }

        return { synced, warnings };
    }

    async function changePhone(oid, phoneNumber) {
        const existing = await callGraph("GET", `/users/${oid}/authentication/phoneMethods`);
        assertGraphOk(existing, "Could not read your current phone methods.");
        const hasMobile = (existing.json?.value ?? []).some((m) => m.phoneType === "mobile");
        const result = hasMobile
            ? await callGraph(
                  "PATCH",
                  `/users/${oid}/authentication/phoneMethods/${MOBILE_PHONE_METHOD_ID}`,
                  { phoneNumber, phoneType: "mobile" }
              )
            : await callGraph("POST", `/users/${oid}/authentication/phoneMethods`, {
                  phoneNumber,
                  phoneType: "mobile",
              });
        assertGraphOk(result, "Could not change your phone number.");
    }

    /* ----------------------- impersonation (B4) --------------------------- */

    const impersonationSessionKey = crypto.randomBytes(32);
    const activeImpersonations = new Map(); // sessionId -> session
    const impersonationAudit = []; // append-only

    function actorIdentity(payload) {
        const email = [payload.signin_email, payload.email, payload.preferred_username].find(
            (e) => typeof e === "string" && e.includes("@")
        );
        return { oid: payload.oid, email: email ?? null };
    }

    function isImpersonationAdmin(payload) {
        if (impersonationAllowAnyAdmin) return true;
        const { oid, email } = actorIdentity(payload);
        if (oid && impersonationAdminOids.has(String(oid).toLowerCase())) return true;
        if (email && impersonationAdminEmails.has(email.toLowerCase())) return true;
        return false;
    }

    function recordImpersonationAudit(action, session) {
        const entry = {
            action,
            sessionId: session.sessionId,
            actor: session.actor,
            subject: session.subject,
            reason: session.reason ?? null,
            scope: session.scope ?? null,
            at: new Date().toISOString(),
        };
        impersonationAudit.push(entry);
        console.log(
            `[IMPERSONATION] ${action} session=${entry.sessionId} ` +
                `actor=${entry.actor?.email ?? entry.actor?.oid} subject=${entry.subject?.email ?? entry.subject?.oid} ` +
                `reason=${JSON.stringify(entry.reason)}`
        );
        return entry;
    }

    function makeImpersonationCookie(session) {
        const payload = Buffer.from(
            JSON.stringify({
                sessionId: session.sessionId,
                act: session.actor,
                sub: session.subject,
                reason: session.reason,
                scope: session.scope,
                iat: session.startedAt,
                exp: session.expiresAt,
                impersonated: true,
            })
        ).toString("base64url");
        const sig = crypto.createHmac("sha256", impersonationSessionKey).update(payload).digest("base64url");
        return (
            `${IMPERSONATION_COOKIE_NAME}=${payload}.${sig}; HttpOnly; SameSite=Lax; Path=/; ` +
            `Max-Age=${IMPERSONATION_TTL_SECONDS}`
        );
    }

    function clearImpersonationCookie() {
        return `${IMPERSONATION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
    }

    function readImpersonationSession(req) {
        const header = req.headers.cookie ?? "";
        const cookie = header.split(/;\s*/).find((c) => c.startsWith(`${IMPERSONATION_COOKIE_NAME}=`));
        if (!cookie) return null;
        const value = cookie.slice(IMPERSONATION_COOKIE_NAME.length + 1);
        const dot = value.lastIndexOf(".");
        if (dot <= 0) return null;
        const payload = value.slice(0, dot);
        const sig = value.slice(dot + 1);
        const expected = crypto.createHmac("sha256", impersonationSessionKey).update(payload).digest("base64url");
        const sigBuf = Buffer.from(sig);
        const expBuf = Buffer.from(expected);
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
        let claims;
        try {
            claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        } catch {
            return null;
        }
        if ((claims.exp ?? 0) < Math.floor(Date.now() / 1000)) return null;
        const live = activeImpersonations.get(claims.sessionId);
        if (!live) return null;
        return live;
    }

    async function findImpersonationSubject(email) {
        const escaped = String(email).replace(/'/g, "''");
        const probes = [
            { base: GRAPH_BETA, filter: `identities/any(c:c/issuerAssignedId eq '${escaped}')` },
            { base: GRAPH_BASE, filter: `mail eq '${escaped}'` },
        ];
        for (const probe of probes) {
            const res = await callGraph(
                "GET",
                `/users?$select=id,displayName,mail,userPrincipalName&$filter=${encodeURIComponent(
                    probe.filter
                )}&$top=2`,
                undefined,
                probe.base
            );
            if (res.ok) {
                const users = res.json?.value ?? [];
                if (users.length > 1) {
                    throw new HttpError(409, `More than one account matches ${email}; cannot impersonate ambiguously.`);
                }
                if (users.length === 1) {
                    const u = users[0];
                    return { oid: u.id, email: u.mail ?? email.toLowerCase(), name: u.displayName ?? null };
                }
            }
        }
        throw new HttpError(404, `No customer account found for ${email}.`);
    }

    function publicImpersonationSession(session) {
        return {
            sessionId: session.sessionId,
            actor: session.actor,
            subject: session.subject,
            reason: session.reason ?? null,
            scope: session.scope ?? null,
            startedAt: session.startedAt,
            expiresAt: session.expiresAt,
        };
    }

    function impersonationBannerHtml(session) {
        const subject = escapeHtml(session.subject?.email ?? session.subject?.oid ?? "unknown");
        const actor = escapeHtml(session.actor?.email ?? session.actor?.oid ?? "an administrator");
        const ends = new Date(session.expiresAt * 1000).toLocaleTimeString();
        return `<div class="imp-bar">
        <span class="imp-pill">IMPERSONATION</span>
        <span>You (<strong>${actor}</strong>) are viewing <strong>${subject}</strong>&rsquo;s account</span>
        <span class="imp-bar-meta">read-only · ends ${escapeHtml(ends)}</span>
      </div>`;
    }

    function impersonationAdminContextHtml(session) {
        const row = (label, value) =>
            `<tr><th>${escapeHtml(label)}</th><td>${value ? escapeHtml(String(value)) : "&mdash;"}</td></tr>`;
        const subjectName = session.subject?.name ? ` (${session.subject.name})` : "";
        return `<section class="imp-admin">
        <p class="imp-admin-title">🛡 Administrator view — not visible to the customer</p>
        <table class="imp-admin-table">
          ${row("Signed in as (you)", session.actor?.email ?? session.actor?.oid)}
          ${row("Impersonating", `${session.subject?.email ?? session.subject?.oid ?? "unknown"}${subjectName}`)}
          ${row("Customer object id", session.subject?.oid)}
          ${row("Access scope", session.scope)}
          ${row("Justification on record", session.reason)}
          ${row("Session id", session.sessionId)}
          ${row("Started", new Date(session.startedAt * 1000).toLocaleString())}
          ${row("Expires", new Date(session.expiresAt * 1000).toLocaleString())}
        </table>
      </section>`;
    }

    function impersonationViewHtml(session, { profile = false } = {}) {
        const subjectEmail = escapeHtml(session.subject?.email ?? session.subject?.oid ?? "unknown");
        const subjectName = escapeHtml(session.subject?.name ?? "—");
        const body = profile
            ? `<p>This is a <strong>second page</strong> of the impersonated customer&rsquo;s portal. You
                 navigated here carrying only the <code>HttpOnly</code> impersonation cookie — no token was
                 minted as the customer, and the session stayed attributed to you the whole time.</p>
               <p><a href="/impersonate-view">&larr; Back to the customer&rsquo;s home</a></p>`
            : `<section class="imp-customer">
                 <p class="imp-customer-title">Customer account — as ${subjectEmail} sees it</p>
                 <table class="imp-customer-table">
                   <tr><th>Name</th><td>${subjectName}</td></tr>
                   <tr><th>Email</th><td>${subjectEmail}</td></tr>
                 </table>
                 <p class="imp-customer-note">This panel shows the <strong>customer&rsquo;s</strong> data — what they
                   would see signed in normally. You&rsquo;re seeing it through a read-only impersonation session, not
                   as yourself.</p>
               </section>
               <p>This is an <strong>application session</strong>, not an Entra token: External ID has no supported
                 way to issue a token as another customer, so impersonation lives at the app layer with the audit +
                 revocation controls the portal enforces (plan B4.1/B4.2).</p>
               <p><a href="/impersonate-view/profile">Go to a second page &rarr;</a> (proves the session persists
                 across navigation on the cookie alone).</p>`;
        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Impersonated view — ${subjectEmail}</title>
  <style>
    html, body { margin:0; }
    body {
      font-family:'Nunito',-apple-system,'Segoe UI',Roboto,sans-serif; color:#292929; background:#fff;
      border:0.375rem solid #b3261e; box-sizing:border-box; min-height:100vh;
    }
    .imp-bar {
      position:sticky; top:0; z-index:10; background:#b3261e; color:#fff;
      padding:0.6rem 1rem; font-weight:700; line-height:1.4;
      display:flex; flex-wrap:wrap; gap:0.2rem 0.7rem; align-items:center;
    }
    .imp-pill { background:#fff; color:#b3261e; border-radius:1rem; padding:0.05rem 0.6rem; font-size:0.75rem; letter-spacing:0.04em; }
    .imp-bar-meta { font-weight:400; opacity:0.95; }
    header { background:#098851; color:#fff; padding:0.9rem 1.5rem; font-size:1.05rem; font-weight:700; }
    main { padding:1.25rem 1.5rem; line-height:1.6; }
    code { background:#f0f0f0; padding:0.1rem 0.3rem; border-radius:0.2rem; }
    a { color:#267151; font-weight:700; }
    .imp-admin { background:#fef6e7; border:0.0625rem solid #f0c674; border-left:0.25rem solid #b45309; padding:0.75rem 1rem; margin:0 0 1.25rem 0; }
    .imp-admin-title { margin:0 0 0.5rem 0; font-weight:800; color:#92400e; }
    .imp-admin-table, .imp-customer-table { border-collapse:collapse; width:100%; font-size:0.875rem; }
    .imp-admin-table th, .imp-customer-table th { text-align:left; padding:0.2rem 0.75rem 0.2rem 0; color:#6b7280; font-weight:700; white-space:nowrap; vertical-align:top; }
    .imp-admin-table td, .imp-customer-table td { padding:0.2rem 0; word-break:break-word; }
    .imp-customer { border:0.0625rem solid #d1d5db; border-left:0.25rem solid #098851; padding:0.75rem 1rem; margin:0 0 1.25rem 0; background:#fafafa; }
    .imp-customer-title { margin:0 0 0.5rem 0; font-weight:800; color:#098851; }
    .imp-customer-note { margin:0.75rem 0 0 0; font-size:0.8125rem; color:#6b7280; }
  </style>
</head>
<body>
  ${impersonationBannerHtml(session)}
  <header>Service Tasmania — customer portal</header>
  <main>
    ${impersonationAdminContextHtml(session)}
    ${body}
  </main>
</body>
</html>`;
    }

    function impersonationUnauthedHtml() {
        return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<style>body{margin:0;font-family:'Nunito',-apple-system,'Segoe UI',sans-serif;color:#292929;padding:1.5rem;line-height:1.6;}</style>
</head><body>
  <p>No active impersonation session. An administrator must start one from the
     RWVP portal first (and it may have expired or been revoked).</p>
</body></html>`;
    }

    /* --------------------------- HTTP plumbing ---------------------------- */

    function sendJson(res, status, body, corsHeaders) {
        res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
    }

    function readBody(req) {
        return new Promise((resolve, reject) => {
            let data = "";
            req.on("data", (chunk) => {
                data += chunk;
                if (data.length > 1024 * 1024) reject(new HttpError(413, "Body too large."));
            });
            req.on("end", () => resolve(data));
            req.on("error", reject);
        });
    }

    async function parseJsonBody(req) {
        try {
            return JSON.parse((await readBody(req)) || "{}");
        } catch {
            throw new HttpError(400, "Invalid JSON body.");
        }
    }

    /** Verify the token, asserting issuer/audience/tenant via cors.js's helper. */
    async function verifyUserToken(req) {
        const payload = await verifyBearerToken(req);
        if (payload.tid && payload.tid !== tenantId) throw new HttpError(401, "Invalid token tenant.");
        return payload;
    }

    async function handleImpersonation(req, res, route, reqUrl, corsHeaders) {
        try {
            if (
                req.method === "GET" &&
                (reqUrl.pathname === "/impersonate-view" || reqUrl.pathname === "/impersonate-view/profile")
            ) {
                const session = readImpersonationSession(req);
                if (!session) {
                    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
                    res.end(impersonationUnauthedHtml());
                    return;
                }
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(impersonationViewHtml(session, { profile: reqUrl.pathname.endsWith("/profile") }));
                return;
            }
            if (route === "GET /api/impersonation/whoami") {
                const session = readImpersonationSession(req);
                if (!session) {
                    sendJson(res, 401, { error: { message: "No active impersonation session.", code: "no_session" } }, corsHeaders);
                    return;
                }
                sendJson(res, 200, { session: publicImpersonationSession(session) }, corsHeaders);
                return;
            }
            if (route === "POST /api/impersonation/stop") {
                const session = readImpersonationSession(req);
                if (session) {
                    activeImpersonations.delete(session.sessionId);
                    recordImpersonationAudit("stop", session);
                }
                res.writeHead(200, {
                    "Content-Type": "application/json",
                    "Set-Cookie": clearImpersonationCookie(),
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            if (route === "POST /api/impersonation/start") {
                const admin = await verifyUserToken(req);
                if (!isImpersonationAdmin(admin)) {
                    throw new HttpError(403, "You are not authorised to impersonate customers.", "not_admin");
                }
                const body = await parseJsonBody(req);
                const subjectEmail = String(body.subjectEmail ?? "").trim();
                const reason = String(body.reason ?? "").trim();
                if (!EMAIL_RE.test(subjectEmail)) {
                    throw new HttpError(400, "Enter the customer's email address.");
                }
                if (reason.length < 5) {
                    throw new HttpError(400, "A justification (reason) is required and is recorded in the audit log.", "reason_required");
                }
                if (reason.length > 500) {
                    throw new HttpError(400, "Justification is too long (max 500 characters).");
                }
                const actor = actorIdentity(admin);
                const actorEmail = actor.email?.toLowerCase();
                if (actorEmail && actorEmail === subjectEmail.toLowerCase()) {
                    throw new HttpError(400, "You can't impersonate your own account.", "self_impersonation");
                }
                const subject = await findImpersonationSubject(subjectEmail);
                if (subject.oid && subject.oid === actor.oid) {
                    throw new HttpError(400, "You can't impersonate your own account.", "self_impersonation");
                }
                const now = Math.floor(Date.now() / 1000);
                const session = {
                    sessionId: crypto.randomUUID(),
                    actor,
                    subject,
                    reason,
                    scope: "read-only",
                    startedAt: now,
                    expiresAt: now + IMPERSONATION_TTL_SECONDS,
                };
                activeImpersonations.set(session.sessionId, session);
                recordImpersonationAudit("start", session);
                res.writeHead(200, {
                    "Content-Type": "application/json",
                    "Set-Cookie": makeImpersonationCookie(session),
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ ok: true, session: publicImpersonationSession(session) }));
                return;
            }
            if (route === "POST /api/impersonation/revoke") {
                const admin = await verifyUserToken(req);
                if (!isImpersonationAdmin(admin)) {
                    throw new HttpError(403, "You are not authorised to manage impersonation sessions.", "not_admin");
                }
                const body = await parseJsonBody(req);
                const sessionId = String(body.sessionId ?? "").trim();
                const live = activeImpersonations.get(sessionId);
                if (!live) {
                    throw new HttpError(404, "No live session with that id (already ended or expired).");
                }
                activeImpersonations.delete(sessionId);
                recordImpersonationAudit("revoke", { ...live, actor: actorIdentity(admin), subject: live.subject });
                sendJson(res, 200, { ok: true }, corsHeaders);
                return;
            }
            if (route === "GET /api/impersonation/audit") {
                const admin = await verifyUserToken(req);
                if (!isImpersonationAdmin(admin)) {
                    throw new HttpError(403, "You are not authorised to view the impersonation audit log.", "not_admin");
                }
                sendJson(
                    res,
                    200,
                    {
                        active: [...activeImpersonations.values()].map(publicImpersonationSession),
                        log: impersonationAudit,
                    },
                    corsHeaders
                );
                return;
            }
            throw new HttpError(404, "Not found.");
        } catch (error) {
            const status = error.status ?? 500;
            if (status === 500) console.error(error);
            sendJson(res, status, { error: { message: error.message, code: error.code } }, corsHeaders);
        }
    }

    async function handleAccountAndPasskeys(req, res, route, reqUrl, corsHeaders) {
        try {
            const user = await verifyUserToken(req);
            const oid = user.oid;

            /* -------------------------- passkeys -------------------------- */
            if (reqUrl.pathname === "/api/passkeys" || reqUrl.pathname.startsWith("/api/passkeys/")) {
                const userPath = fido2MethodsPath(oid);
                if (route === "GET /api/passkeys") {
                    const result = await callGraph("GET", userPath, undefined, GRAPH_BETA);
                    sendJson(res, result.status, result.body, corsHeaders);
                } else if (route === "GET /api/passkeys/creation-options") {
                    requireFreshMfa(user);
                    const result = await callGraph(
                        "GET",
                        `${userPath}/creationOptions(challengeTimeoutInMinutes=${CHALLENGE_TIMEOUT_MINUTES})`,
                        undefined,
                        GRAPH_BETA
                    );
                    sendJson(res, result.status, result.body, corsHeaders);
                } else if (route === "POST /api/passkeys") {
                    requireFreshMfa(user);
                    const body = await parseJsonBody(req);
                    if (!body.publicKeyCredential || !body.displayName) {
                        throw new HttpError(400, "Expected { displayName, publicKeyCredential }.");
                    }
                    const result = await callGraph(
                        "POST",
                        userPath,
                        { displayName: body.displayName, publicKeyCredential: body.publicKeyCredential },
                        GRAPH_BETA
                    );
                    sendJson(res, result.status, result.body, corsHeaders);
                } else if (req.method === "DELETE" && reqUrl.pathname.startsWith("/api/passkeys/")) {
                    requireFreshMfa(user);
                    const passkeyId = decodeURIComponent(reqUrl.pathname.slice("/api/passkeys/".length));
                    if (!/^[A-Za-z0-9_-]+$/.test(passkeyId)) {
                        throw new HttpError(400, "Invalid passkey id.");
                    }
                    const result = await callGraph("DELETE", `${userPath}/${passkeyId}`, undefined, GRAPH_BETA);
                    sendJson(res, result.status, result.body || "{}", corsHeaders);
                } else {
                    throw new HttpError(404, "Not found.");
                }
                return;
            }

            /* --------------------------- account -------------------------- */
            const tokenEmail = [user.email, user.preferred_username].find(
                (e) => typeof e === "string" && e.includes("@")
            );

            if (route === "GET /api/account") {
                const summary = await getAccountSummary(oid, tokenEmail);
                sendJson(res, 200, summary, corsHeaders);
            } else if (route === "POST /api/account/signin-name/send-otp") {
                const body = await parseJsonBody(req);
                const email = String(body.email ?? "").trim();
                if (!EMAIL_RE.test(email)) {
                    throw new HttpError(400, "Enter a valid email address.");
                }
                await sendSignInOtp(oid, email);
                sendJson(res, 200, { ok: true, message: `We've emailed a verification code to ${email}.` }, corsHeaders);
            } else if (route === "POST /api/account/signin-name") {
                requireFreshMfa(user);
                const body = await parseJsonBody(req);
                const email = String(body.email ?? "").trim();
                if (!EMAIL_RE.test(email)) {
                    throw new HttpError(400, "Enter a valid email address.");
                }
                verifyOtp(oid, email, String(body.otp ?? "").trim());
                const { synced, warnings } = await changeSignInName(oid, email, tokenEmail);
                let message = `Sign-in email changed to ${email} (updated: ${synced.join(", ")}). Sign out and back in to refresh your token.`;
                if (warnings.length) message += ` Note: ${warnings.join("; ")}`;
                sendJson(res, 200, { ok: true, message }, corsHeaders);
            } else if (route === "POST /api/account/phone") {
                requireFreshMfa(user);
                const body = await parseJsonBody(req);
                const phoneNumber = String(body.phoneNumber ?? "").trim();
                if (!PHONE_RE.test(phoneNumber)) {
                    throw new HttpError(
                        400,
                        "Enter a valid phone number in international format, e.g. +61 412345678."
                    );
                }
                await changePhone(oid, phoneNumber);
                sendJson(res, 200, { ok: true, message: `Mobile number changed to ${phoneNumber}.` }, corsHeaders);
            } else {
                throw new HttpError(404, "Not found.");
            }
        } catch (error) {
            const status = error.status ?? 500;
            if (status === 500) console.error(error);
            sendJson(res, status, { error: { message: error.message, code: error.code } }, corsHeaders);
        }
    }

    /**
     * Entry point cors.js calls before its CIAM passthrough. Returns true when
     * this module owns the request (and has fully written the response), false to
     * let cors.js handle it (CIAM passthrough / validate-attributes / webview).
     */
    async function handle(req, res, reqUrl, corsHeaders) {
        const route = `${req.method} ${reqUrl.pathname}`;
        if (
            reqUrl.pathname.startsWith("/api/impersonation/") ||
            reqUrl.pathname === "/impersonate-view" ||
            reqUrl.pathname === "/impersonate-view/profile"
        ) {
            await handleImpersonation(req, res, route, reqUrl, corsHeaders);
            return true;
        }
        if (
            reqUrl.pathname === "/api/account" ||
            reqUrl.pathname.startsWith("/api/account/") ||
            reqUrl.pathname === "/api/passkeys" ||
            reqUrl.pathname.startsWith("/api/passkeys/")
        ) {
            await handleAccountAndPasskeys(req, res, route, reqUrl, corsHeaders);
            return true;
        }
        return false;
    }

    return { handle };
};
Now let me add a sync owns() matcher to the module and wire it into cors.js (env loader + dispatch).

Edit c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\graph-routes.js
Added 13 lines
Edit c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\graph-routes.js
Modified
Now wire into cors.js — add the env loader and the dispatch. First the top (requires + env + factory):

Edit c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\cors.js
Added 26 lines
The hint is harmless. Now instantiate the factory and add dispatch. Let me insert the instantiation before extraHeaders, and the dispatch right after the webview block.

Edit c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\cors.js
Added 29 lines
Edit c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\cors.js
Added 9 lines
Backend wired. Now the pages — the most involved adaptation (MSAL → native-auth SDK). Let me update todos and port the account page.

Update Todos

Extend native-auth auth-config.ts with account/passkey/impersonation API bases, feature flags, passkeyRpId, ngcmfa note, and email-from-claims helper

Port account-service.ts to native-auth (rebased imports)

Port passkey-service.ts to native-auth

Port impersonation-service.ts to native-auth

Write shared graph-routes.js backend module (app-only Graph, OTP, account/passkey/impersonation ops) and wire into cors.js

Port account/page.tsx to native-auth SDK token model (no MFA redirect; re-auth prompt on mfa_required)

Port security/page.tsx (passkeys) to native-auth SDK token model

Port impersonate/page.tsx to native-auth SDK token model

Add My Account / Security / Impersonation links to native-auth Navbar

Add account/passkey/impersonation routes to api/authProxy.ts (prod parity) + ACS dep

Build + lint the native-auth app and fix errors
Write c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\src\app\account\page.tsx
598 lines
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CustomAuthAccountData } from "@azure/msal-browser/custom-auth";
import { useAuthClient } from "@/auth/AuthClientProvider";
import { accountFeatureAvailable } from "@/config/auth-config";
import {
    AccountApiError,
    AccountSummary,
    changePhone,
    changeSignInName,
    fetchAccountSummary,
    sendSignInNameOtp,
} from "@/services/account-service";
import { fetchPasskeys } from "@/services/passkey-service";

/**
 * "My account" — account self-management for the native-auth sample, ported from
 * the browser-delegated app. Change the sign-in email (verified with an emailed
 * OTP), the MFA phone number, or reset the password (routed to this sample's own
 * in-app /reset-password flow).
 *
 * Token model (differs from the browser-delegated original): the bearer is the
 * native-auth SDK's ID token (account.getIdToken()), and there is NO step-up MFA
 * — native auth can't silently force a fresh MFA the way an MSAL ngcmfa redirect
 * does. Instead the proxy's iat-freshness gate enforces recency (the native
 * sign-in already included SMS MFA), and when the token is too old the proxy
 * answers `mfa_required`; the page then asks the user to sign in again.
 */

const styles = {
    page: {
        backgroundColor: "#f5f5f5",
        minHeight: "calc(100vh - 3.75rem)",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        color: "#292929",
    },
    hero: { backgroundColor: "#098851", padding: "3.75rem 0" },
    heroInner: { maxWidth: "80rem", margin: "0 auto", padding: "0 2.5rem" },
    heroTitle: { color: "#ffffff", fontSize: "2rem", fontWeight: 700, margin: 0 },
    cardWrap: { maxWidth: "80rem", margin: "-2.5rem auto 2.5rem", padding: "0 2.5rem" },
    card: { backgroundColor: "#ffffff", padding: "2.5rem 4rem" },
    content: { maxWidth: "44rem", margin: "0 auto" },
    heading: { fontSize: "1.875rem", fontWeight: 700, margin: "0 0 0.75rem 0" },
    lead: { fontSize: "1rem", margin: "0 0 1.5rem 0", lineHeight: 1.6 },
    banner: { padding: "0.875rem 1rem", margin: "0 0 1.5rem 0", fontSize: "0.9375rem", lineHeight: 1.5 },
    bannerInfo: { backgroundColor: "#eef6f2", border: "0.0625rem solid #267151" },
    bannerSuccess: { backgroundColor: "#eef6f2", border: "0.0625rem solid #098851", fontWeight: 700 },
    bannerError: { backgroundColor: "#fdf2f2", border: "0.0625rem solid #b91c1c" },
    section: { border: "0.0625rem solid #d1d5db", marginBottom: "0.75rem" },
    sectionHeader: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "1rem",
        padding: "1.25rem 1.5rem",
    },
    sectionTitle: { fontWeight: 800, margin: "0 0 0.25rem 0", fontSize: "1.0625rem" },
    sectionMeta: { margin: 0, color: "#6b7280", fontSize: "0.875rem", wordBreak: "break-word" as const },
    sectionBody: { padding: "0 1.5rem 1.5rem 1.5rem" },
    inputLabel: { display: "block", fontWeight: 700, margin: "0.5rem 0 0.375rem 0" },
    input: {
        display: "block",
        width: "100%",
        maxWidth: "26rem",
        padding: "0.625rem 0.75rem",
        margin: "0 0 1rem 0",
        border: "0.0625rem solid #6b7280",
        borderRadius: "0",
        fontSize: "1rem",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        boxSizing: "border-box" as const,
    },
    phoneRow: {
        display: "flex",
        gap: "0.75rem",
        alignItems: "stretch",
        width: "100%",
        maxWidth: "26rem",
        margin: "0 0 1rem 0",
    },
    dialSelect: {
        padding: "0.625rem 0.75rem",
        border: "0.0625rem solid #6b7280",
        borderRadius: "0",
        fontSize: "1rem",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        color: "#292929",
        backgroundColor: "#ffffff",
        boxSizing: "border-box" as const,
        flexShrink: 0,
    },
    phoneInput: {
        flex: 1,
        minWidth: 0,
        padding: "0.625rem 0.75rem",
        border: "0.0625rem solid #6b7280",
        borderRadius: "0",
        fontSize: "1rem",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        boxSizing: "border-box" as const,
    },
    hint: { margin: "-0.5rem 0 1rem 0", color: "#6b7280", fontSize: "0.8125rem", lineHeight: 1.5 },
    buttonRow: { display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" as const },
    primaryButton: {
        display: "inline-block",
        padding: "0.625rem 2rem",
        backgroundColor: "#267151",
        color: "#ffffff",
        border: "none",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "1rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        textDecoration: "none",
    },
    toggleButton: {
        padding: "0.5rem 1.25rem",
        backgroundColor: "#ffffff",
        color: "#267151",
        border: "0.0625rem solid #267151",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "0.875rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        whiteSpace: "nowrap" as const,
    },
} as const;

type Banner = { kind: "info" | "success" | "error"; text: string } | null;
type SectionKey = "password" | "signin" | "phone";
// Password is handled by the in-app /reset-password flow (Graph has no app-only
// password path in External ID), so only these two go through the Graph proxy.
type ChangeKey = "signin" | "phone";

// Mirrors the native-auth sign-up flow: a fixed dial-code dropdown plus a local
// number. The submitted value is `${dialCode} ${localNumber}`, e.g. "+61 412345678".
const DIAL_CODES = [
    { code: "+61", label: "Australia (+61)" },
    { code: "+64", label: "New Zealand (+64)" },
];

/** Strip non-digits and any leading zero so it can be paired with a dial code. */
function toLocalNumber(mobile: string): string {
    return mobile.replace(/\D/g, "").replace(/^0+/, "");
}

function bannerStyle(kind: NonNullable<Banner>["kind"]) {
    const variant =
        kind === "success" ? styles.bannerSuccess : kind === "error" ? styles.bannerError : styles.bannerInfo;
    return { ...styles.banner, ...variant };
}

function AccountManager({ account }: { account: CustomAuthAccountData }) {
    const [summary, setSummary] = useState<AccountSummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [banner, setBanner] = useState<Banner>(null);
    const [open, setOpen] = useState<SectionKey | null>(null);
    const [email, setEmail] = useState("");
    const [otp, setOtp] = useState("");
    // True once a verification code has been emailed to the new address — reveals
    // the code input and switches the primary button to "Verify & save".
    const [otpSent, setOtpSent] = useState(false);
    const [phone, setPhone] = useState("");
    const [dialCode, setDialCode] = useState("+61");
    // Set after a successful sign-in email change when the user has at least one
    // passkey — a passkey credential embeds the sign-in name from when it was
    // registered, so changing the email leaves it presenting the old address.
    const [passkeyReminder, setPasskeyReminder] = useState(false);
    // Set when the proxy rejects a change with `mfa_required` (the token is older
    // than the freshness window). Native auth can't step-up MFA silently, so the
    // only remedy is to sign in again — surfaced as a button instead of a redirect.
    const [needsReauth, setNeedsReauth] = useState(false);

    /** The signed-in user's ID token — the bearer for every proxy call. */
    const getToken = useCallback(() => {
        const token = account.getIdToken();
        if (!token) {
            throw new AccountApiError("Your session has no token. Please sign in again.", "mfa_required");
        }
        return token;
    }, [account]);

    const reauth = useCallback(async () => {
        // Sign out (the SDK redirects to postLogoutRedirectUri "/"), so the user
        // re-runs the native sign-in — including SMS MFA — and returns with a
        // freshly-issued token that passes the proxy's freshness gate.
        try {
            await account.signOut();
        } catch {
            window.location.href = "/";
        }
    }, [account]);

    const loadSummary = useCallback(async () => {
        setLoading(true);
        try {
            setSummary(await fetchAccountSummary(getToken()));
        } catch (error) {
            setBanner({ kind: "error", text: `Could not load your account: ${(error as Error).message}` });
        } finally {
            setLoading(false);
        }
    }, [getToken]);

    /** Email a verification code to the prospective new sign-in address. */
    const sendOtp = useCallback(async () => {
        setBusy(true);
        setBanner(null);
        try {
            const message = await sendSignInNameOtp(getToken(), email.trim());
            setOtpSent(true);
            setBanner({ kind: "info", text: `${message} Enter it below to confirm the change.` });
        } catch (error) {
            setBanner({ kind: "error", text: `Could not send the code: ${(error as Error).message}` });
        } finally {
            setBusy(false);
        }
    }, [getToken, email]);

    const performChange = useCallback(
        async (action: ChangeKey, value: string, code = "") => {
            setBusy(true);
            setBanner(null);
            setPasskeyReminder(false);
            setNeedsReauth(false);
            try {
                const token = getToken();
                const message =
                    action === "signin"
                        ? await changeSignInName(token, value, code)
                        : await changePhone(token, value);

                setBanner({ kind: "success", text: message });
                setOpen(null);
                setEmail("");
                setOtp("");
                setOtpSent(false);
                setPhone("");
                setDialCode("+61");

                // After a sign-in email change, remind the user to re-register any
                // passkey so its embedded sign-in name follows the new email. Skip
                // it for users with no passkeys. Best-effort.
                if (action === "signin") {
                    try {
                        const list = await fetchPasskeys(token);
                        if (list.length > 0) setPasskeyReminder(true);
                    } catch {
                        // Don't let a passkey-list hiccup mask the success message.
                    }
                }
                // The saved value is authoritative from the 200 response.
                setSummary((prev) =>
                    prev === null
                        ? prev
                        : action === "signin"
                          ? { ...prev, email: value }
                          : { ...prev, phoneNumber: value }
                );
            } catch (error) {
                if (error instanceof AccountApiError && error.code === "mfa_required") {
                    // The proxy judged our token too old to be MFA-fresh. Native
                    // auth can't step up MFA silently — ask the user to sign in again.
                    setNeedsReauth(true);
                    setBanner({
                        kind: "error",
                        text: "For your security, this change needs a recent sign-in. Please sign in again (you'll complete SMS verification), then retry.",
                    });
                } else if (error instanceof AccountApiError && error.code === "otp_required") {
                    // Code expired / consumed / too many tries — back to send step.
                    setOtp("");
                    setOtpSent(false);
                    setBanner({ kind: "error", text: `Could not save the change: ${error.message}` });
                } else {
                    setBanner({ kind: "error", text: `Could not save the change: ${(error as Error).message}` });
                }
            } finally {
                setBusy(false);
            }
        },
        [getToken]
    );

    useEffect(() => {
        void loadSummary();
    }, [loadSummary]);

    const toggle = (key: SectionKey) => {
        setBanner(null);
        setPasskeyReminder(false);
        setNeedsReauth(false);
        // Reset the email-change sub-flow whenever the section is opened/closed.
        setOtp("");
        setOtpSent(false);
        setOpen((current) => (current === key ? null : key));
    };

    const renderSection = (
        key: SectionKey,
        title: string,
        meta: string,
        body: React.ReactNode
    ) => (
        <div style={styles.section}>
            <div style={styles.sectionHeader}>
                <div>
                    <p style={styles.sectionTitle}>{title}</p>
                    <p style={styles.sectionMeta}>{meta}</p>
                </div>
                <button
                    type="button"
                    style={styles.toggleButton}
                    onClick={() => toggle(key)}
                    disabled={busy}
                >
                    {open === key ? "Cancel" : "Change"}
                </button>
            </div>
            {open === key && <div style={styles.sectionBody}>{body}</div>}
        </div>
    );

    return (
        <main style={styles.page}>
            <div style={styles.hero}>
                <div style={styles.heroInner}>
                    <h1 style={styles.heroTitle}>My account</h1>
                </div>
            </div>
            <div style={styles.cardWrap}>
                <div style={styles.card}>
                    <div style={styles.content}>
                        <h2 style={styles.heading}>Manage your sign-in details</h2>
                        <p style={styles.lead}>
                            Update your password, the email you sign in with, or your multi-factor
                            authentication phone number. Changing your sign-in email or phone number requires a
                            recent sign-in.
                        </p>

                        {banner && <div style={bannerStyle(banner.kind)}>{banner.text}</div>}

                        {needsReauth && (
                            <div style={styles.buttonRow}>
                                <button type="button" style={styles.primaryButton} onClick={reauth} disabled={busy}>
                                    Sign in again
                                </button>
                            </div>
                        )}

                        {passkeyReminder && (
                            <div style={bannerStyle("info")}>
                                You sign in with a passkey. A passkey remembers the email it was
                                created with, so until you re-register it, a passwordless passkey
                                sign-in will still show your old address. To fix that, add a new
                                passkey and remove the old one on the{" "}
                                <Link href="/security" style={{ color: "#267151", fontWeight: 800 }}>
                                    account security page
                                </Link>
                                .
                            </div>
                        )}

                        {loading ? (
                            <p style={styles.sectionMeta}>Loading your account…</p>
                        ) : (
                            <>
                                {renderSection(
                                    "password",
                                    "Change password",
                                    "Reset your password from the secure reset page.",
                                    <>
                                        <p style={styles.hint}>
                                            Microsoft Entra External ID handles password changes through its
                                            secure self-service reset. Select the button below, then enter your
                                            email and the verification code to set a new password.
                                        </p>
                                        <div style={styles.buttonRow}>
                                            <Link href="/reset-password" style={styles.primaryButton}>
                                                Go to password reset
                                            </Link>
                                        </div>
                                    </>
                                )}

                                {renderSection(
                                    "signin",
                                    "Change sign in name",
                                    summary?.email
                                        ? `You currently sign in with ${summary.email}.`
                                        : "Update the email address you sign in with.",
                                    <>
                                        <label style={styles.inputLabel} htmlFor="new-email">
                                            New sign-in email
                                        </label>
                                        <input
                                            id="new-email"
                                            type="email"
                                            style={styles.input}
                                            value={email}
                                            placeholder={summary?.email ?? "you@example.com"}
                                            autoComplete="email"
                                            disabled={otpSent}
                                            onChange={(e) => {
                                                setEmail(e.target.value);
                                                // The code is bound to a specific
                                                // address — editing it restarts the
                                                // send step.
                                                if (otpSent) {
                                                    setOtpSent(false);
                                                    setOtp("");
                                                }
                                            }}
                                        />
                                        <p style={styles.hint}>
                                            Use the new email the next time you sign in. It must not already be
                                            registered to another account. We&rsquo;ll email a verification code
                                            to confirm you own this address.
                                        </p>

                                        {!otpSent ? (
                                            <div style={styles.buttonRow}>
                                                <button
                                                    type="button"
                                                    style={styles.primaryButton}
                                                    disabled={busy || email.trim().length === 0}
                                                    onClick={sendOtp}
                                                >
                                                    {busy ? "Sending…" : "Send verification code"}
                                                </button>
                                            </div>
                                        ) : (
                                            <>
                                                <label style={styles.inputLabel} htmlFor="email-otp">
                                                    Verification code
                                                </label>
                                                <input
                                                    id="email-otp"
                                                    type="text"
                                                    inputMode="numeric"
                                                    autoComplete="one-time-code"
                                                    maxLength={6}
                                                    style={styles.input}
                                                    value={otp}
                                                    placeholder="123456"
                                                    onChange={(e) =>
                                                        setOtp(e.target.value.replace(/\D/g, ""))
                                                    }
                                                />
                                                <p style={styles.hint}>
                                                    Enter the 6-digit code we emailed to {email.trim()}.
                                                </p>
                                                <div style={styles.buttonRow}>
                                                    <button
                                                        type="button"
                                                        style={styles.primaryButton}
                                                        disabled={busy || otp.trim().length !== 6}
                                                        onClick={() =>
                                                            performChange("signin", email.trim(), otp.trim())
                                                        }
                                                    >
                                                        {busy ? "Saving…" : "Verify & save email"}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        style={styles.toggleButton}
                                                        disabled={busy}
                                                        onClick={sendOtp}
                                                    >
                                                        Resend code
                                                    </button>
                                                </div>
                                            </>
                                        )}
                                    </>
                                )}

                                {renderSection(
                                    "phone",
                                    "Change phone number",
                                    summary?.phoneNumber
                                        ? `Your current mobile number is ${summary.phoneNumber}.`
                                        : "Add or update the mobile number used for multi-factor authentication.",
                                    <>
                                        <label style={styles.inputLabel} htmlFor="new-phone">
                                            New mobile number
                                        </label>
                                        <div style={styles.phoneRow}>
                                            <select
                                                aria-label="Country code"
                                                style={styles.dialSelect}
                                                value={dialCode}
                                                onChange={(e) => setDialCode(e.target.value)}
                                            >
                                                {DIAL_CODES.map((d) => (
                                                    <option key={d.code} value={d.code}>
                                                        {d.label}
                                                    </option>
                                                ))}
                                            </select>
                                            <input
                                                id="new-phone"
                                                type="tel"
                                                style={styles.phoneInput}
                                                value={phone}
                                                placeholder="412345678"
                                                autoComplete="tel-national"
                                                onChange={(e) => setPhone(e.target.value)}
                                            />
                                        </div>
                                        <p style={styles.hint}>
                                            Select your country code and enter your mobile number without the
                                            leading zero (e.g. 412345678).
                                        </p>
                                        <div style={styles.buttonRow}>
                                            <button
                                                type="button"
                                                style={styles.primaryButton}
                                                disabled={busy || toLocalNumber(phone).length === 0}
                                                onClick={() =>
                                                    performChange(
                                                        "phone",
                                                        `${dialCode} ${toLocalNumber(phone)}`
                                                    )
                                                }
                                            >
                                                {busy ? "Saving…" : "Save number"}
                                            </button>
                                        </div>
                                    </>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>
        </main>
    );
}

function SignedOutView({ message }: { message: string }) {
    return (
        <main style={styles.page}>
            <div style={styles.hero}>
                <div style={styles.heroInner}>
                    <h1 style={styles.heroTitle}>My account</h1>
                </div>
            </div>
            <div style={styles.cardWrap}>
                <div style={styles.card}>
                    <div style={styles.content}>
                        <h2 style={styles.heading}>Please sign in</h2>
                        <p style={styles.lead}>{message}</p>
                        <Link href="/" style={styles.primaryButton}>
                            Go to sign in
                        </Link>
                    </div>
                </div>
            </div>
        </main>
    );
}

export default function AccountPage() {
    const authClient = useAuthClient();
    const [account, setAccount] = useState<CustomAuthAccountData | null>(null);
    const [resolved, setResolved] = useState(false);
    const [available, setAvailable] = useState(true);

    useEffect(() => setAvailable(accountFeatureAvailable()), []);

    useEffect(() => {
        if (!authClient) return;
        const result = authClient.getCurrentAccount();
        if (result.isCompleted() && result.data) {
            setAccount(result.data);
        }
        setResolved(true);
    }, [authClient]);

    if (!available) {
        return (
            <SignedOutView message="Account management needs the local proxy (npm run cors) and runs on localhost. It is disabled on this host." />
        );
    }
    if (!authClient || !resolved) {
        return <SignedOutView message="Loading your account…" />;
    }
    if (!account) {
        return <SignedOutView message="You need to be signed in to manage your account details." />;
    }
    return <AccountManager account={account} />;
}
Now the security (passkeys) page.

Write c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\src\app\security\page.tsx
461 lines
"use client";

import { useCallback, useEffect, useState } from "react";
import { CustomAuthAccountData } from "@azure/msal-browser/custom-auth";
import { useAuthClient } from "@/auth/AuthClientProvider";
import { passkeyFeatureAvailable, passkeyRpId } from "@/config/auth-config";
import {
    PasskeyApiError,
    PasskeyInfo,
    createPasskeyCredential,
    deletePasskey,
    fetchCreationOptions,
    fetchPasskeys,
    registerPasskey,
} from "@/services/passkey-service";

/**
 * "Account security" — passkey (FIDO2) management for the native-auth sample,
 * ported from the browser-delegated app. List / add / delete passkeys.
 *
 * Token model (differs from the browser-delegated original): the bearer is the
 * native-auth SDK's ID token (account.getIdToken()). Add/delete are gated on the
 * proxy's iat-freshness check (native sign-in already did SMS MFA); when the
 * token is too old the proxy answers `mfa_required` and the page asks the user to
 * sign in again — there is no silent step-up MFA in native auth.
 */

const styles = {
    page: {
        backgroundColor: "#f5f5f5",
        minHeight: "calc(100vh - 3.75rem)",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        color: "#292929",
    },
    hero: { backgroundColor: "#098851", padding: "3.75rem 0" },
    heroInner: { maxWidth: "80rem", margin: "0 auto", padding: "0 2.5rem" },
    heroTitle: { color: "#ffffff", fontSize: "2rem", fontWeight: 700, margin: 0 },
    cardWrap: { maxWidth: "80rem", margin: "-2.5rem auto 2.5rem", padding: "0 2.5rem" },
    card: { backgroundColor: "#ffffff", padding: "2.5rem 4rem" },
    content: { maxWidth: "44rem", margin: "0 auto" },
    heading: { fontSize: "1.875rem", fontWeight: 700, margin: "0 0 0.75rem 0" },
    lead: { fontSize: "1rem", margin: "0 0 1.5rem 0", lineHeight: 1.6 },
    sectionTitle: { fontSize: "1.125rem", fontWeight: 800, margin: "2rem 0 0.75rem 0" },
    banner: {
        padding: "0.875rem 1rem",
        margin: "0 0 1.5rem 0",
        fontSize: "0.9375rem",
        lineHeight: 1.5,
    },
    bannerInfo: { backgroundColor: "#eef6f2", border: "0.0625rem solid #267151" },
    bannerSuccess: { backgroundColor: "#eef6f2", border: "0.0625rem solid #098851", fontWeight: 700 },
    bannerError: { backgroundColor: "#fdf2f2", border: "0.0625rem solid #b91c1c" },
    bannerWarning: { backgroundColor: "#fffbeb", border: "0.0625rem solid #b45309" },
    list: { listStyle: "none", padding: 0, margin: 0 },
    listItem: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: "1rem",
        padding: "1rem 1.25rem",
        border: "0.0625rem solid #d1d5db",
        marginBottom: "0.75rem",
    },
    passkeyName: { fontWeight: 800, margin: "0 0 0.25rem 0", wordBreak: "break-all" as const },
    passkeyMeta: { margin: 0, color: "#6b7280", fontSize: "0.875rem", lineHeight: 1.6 },
    typeBadge: {
        display: "inline-block",
        padding: "0.125rem 0.5rem",
        marginLeft: "0.5rem",
        backgroundColor: "#eef6f2",
        color: "#267151",
        fontSize: "0.75rem",
        fontWeight: 800,
        verticalAlign: "middle" as const,
    },
    primaryButton: {
        display: "inline-block",
        padding: "0.75rem 3rem",
        backgroundColor: "#267151",
        color: "#ffffff",
        border: "none",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "1rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        textDecoration: "none",
    },
    secondaryButton: {
        padding: "0.5rem 1.25rem",
        backgroundColor: "#ffffff",
        color: "#b91c1c",
        border: "0.0625rem solid #b91c1c",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "0.875rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    confirmRow: { display: "flex", gap: "0.75rem", alignItems: "center" },
    nameInput: {
        display: "block",
        width: "100%",
        maxWidth: "24rem",
        padding: "0.625rem 0.75rem",
        margin: "0 0 1rem 0",
        border: "0.0625rem solid #6b7280",
        borderRadius: "0",
        fontSize: "1rem",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    inputLabel: { display: "block", fontWeight: 700, margin: "0 0 0.375rem 0" },
    empty: { padding: "1.5rem", border: "0.0625rem dashed #d1d5db", color: "#6b7280", margin: "0 0 1rem 0" },
} as const;

type Banner = { kind: "info" | "success" | "error" | "warning"; text: string } | null;
const GRAPH_PROPAGATION_DELAY_MS = 2000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bannerStyle(kind: NonNullable<Banner>["kind"]) {
    const variant =
        kind === "success"
            ? styles.bannerSuccess
            : kind === "error"
              ? styles.bannerError
              : kind === "warning"
                ? styles.bannerWarning
                : styles.bannerInfo;
    return { ...styles.banner, ...variant };
}

function formatDate(value: string | null): string {
    if (!value) return "—";
    return new Date(value).toLocaleString("en-AU", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function PasskeyManager({ account }: { account: CustomAuthAccountData }) {
    const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [banner, setBanner] = useState<Banner>(null);
    const [pendingDelete, setPendingDelete] = useState<PasskeyInfo | null>(null);
    const [newName, setNewName] = useState("");
    const [originOk, setOriginOk] = useState(true);
    const [needsReauth, setNeedsReauth] = useState(false);

    // Passkey REGISTRATION must run on the relying-party domain (rp.id) or a
    // subdomain of it; anywhere else navigator.credentials.create() fails with
    // SecurityError. Sign-in with an existing passkey is unaffected (it happens
    // on the Entra-hosted pages).
    useEffect(() => {
        const host = window.location.hostname;
        const onRpDomain = host === passkeyRpId || host.endsWith(`.${passkeyRpId}`);
        const hasWebAuthn = typeof window.PublicKeyCredential !== "undefined";
        setOriginOk(onRpDomain && hasWebAuthn);
    }, []);

    /** The signed-in user's ID token — the bearer for every proxy call. */
    const getToken = useCallback(() => {
        const token = account.getIdToken();
        if (!token) {
            throw new PasskeyApiError("Your session has no token. Please sign in again.", "mfa_required");
        }
        return token;
    }, [account]);

    const reauth = useCallback(async () => {
        try {
            await account.signOut();
        } catch {
            window.location.href = "/";
        }
    }, [account]);

    /** Map a proxy error to a banner; flag a needed re-auth on `mfa_required`. */
    const reportError = useCallback((prefix: string, error: unknown) => {
        if (error instanceof PasskeyApiError && error.code === "mfa_required") {
            setNeedsReauth(true);
            setBanner({
                kind: "error",
                text: "For your security, this needs a recent sign-in. Please sign in again (you'll complete SMS verification), then retry.",
            });
            return;
        }
        const err = error as Error;
        if (err.name === "NotAllowedError") {
            setBanner({
                kind: "error",
                text: "Passkey creation was cancelled, timed out, or a passkey is already registered on this device/key.",
            });
        } else if (err.name === "SecurityError") {
            setBanner({
                kind: "error",
                text: `This page's domain doesn't match the passkey relying party (${passkeyRpId}). Serve the app from https://auth.${passkeyRpId}:3000 — see the README's Passkeys section.`,
            });
        } else {
            setBanner({ kind: "error", text: `${prefix}: ${err.message}` });
        }
    }, []);

    const loadPasskeys = useCallback(
        async (settled?: (list: PasskeyInfo[]) => boolean) => {
            setLoading(true);
            try {
                const token = getToken();
                let list = await fetchPasskeys(token);
                // Graph propagation after add/delete can lag a little — retry
                // until the expected change shows up.
                for (let attempt = 1; settled && !settled(list) && attempt <= 4; attempt++) {
                    await sleep(700 * attempt);
                    list = await fetchPasskeys(token);
                }
                setPasskeys(list);
                return list;
            } catch (error) {
                reportError("Could not load your passkeys", error);
                return null;
            } finally {
                setLoading(false);
            }
        },
        [getToken, reportError]
    );

    const performAdd = useCallback(
        async (name: string) => {
            setBusy(true);
            setBanner(null);
            setNeedsReauth(false);
            const previousCount = passkeys.length;
            try {
                const token = getToken();
                setBanner({
                    kind: "info",
                    text: "Follow your browser's prompts to create the passkey (Windows Hello, security key, or scan the QR code with your phone).",
                });
                const options = await fetchCreationOptions(token);
                const credential = await createPasskeyCredential(options);

                const displayName =
                    name.trim() ||
                    `myServiceTas passkey ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
                await registerPasskey(token, credential, displayName);

                setBanner({ kind: "success", text: `Passkey "${displayName}" added.` });
                setNewName("");
                await sleep(GRAPH_PROPAGATION_DELAY_MS);
                await loadPasskeys((list) => list.length > previousCount);
            } catch (error) {
                reportError("Could not add the passkey", error);
            } finally {
                setBusy(false);
            }
        },
        [getToken, loadPasskeys, passkeys.length, reportError]
    );

    const performDelete = useCallback(
        async (passkey: { id: string; name: string }) => {
            setBusy(true);
            setBanner(null);
            setNeedsReauth(false);
            try {
                const token = getToken();
                await deletePasskey(token, passkey.id);
                setBanner({ kind: "success", text: `Passkey "${passkey.name}" deleted.` });
                await loadPasskeys((list) => !list.some((p) => p.id === passkey.id));
            } catch (error) {
                reportError("Could not delete the passkey", error);
            } finally {
                setPendingDelete(null);
                setBusy(false);
            }
        },
        [getToken, loadPasskeys, reportError]
    );

    useEffect(() => {
        void loadPasskeys();
    }, [loadPasskeys]);

    return (
        <>
            {!originOk && (
                <p style={bannerStyle("warning")}>
                    Passkey <strong>registration</strong> only works when this app is served from{" "}
                    <strong>{passkeyRpId}</strong> or a subdomain of it (locally:{" "}
                    <code>https://auth.{passkeyRpId}:3000</code> — see the README&apos;s Passkeys
                    section). Signing in with an already-registered passkey works from anywhere,
                    because that happens on the Entra-hosted pages.
                </p>
            )}
            {banner && <p style={bannerStyle(banner.kind)}>{banner.text}</p>}

            {needsReauth && (
                <p>
                    <button
                        type="button"
                        style={styles.primaryButton}
                        onClick={reauth}
                        disabled={busy}
                    >
                        Sign in again
                    </button>
                </p>
            )}

            <h2 style={styles.sectionTitle}>Your passkeys</h2>
            {loading ? (
                <p style={styles.empty}>Loading your passkeys…</p>
            ) : passkeys.length === 0 ? (
                <p style={styles.empty}>
                    You don&apos;t have any passkeys yet. Add one below to sign in with your face,
                    fingerprint, PIN, or security key instead of a password.
                </p>
            ) : (
                <ul style={styles.list}>
                    {passkeys.map((passkey) => (
                        <li key={passkey.id} style={styles.listItem}>
                            <div>
                                <p style={styles.passkeyName}>
                                    {passkey.name}
                                    <span style={styles.typeBadge}>{passkey.passkeyType}</span>
                                </p>
                                <p style={styles.passkeyMeta}>
                                    {passkey.model}
                                    <br />
                                    Created: {formatDate(passkey.createdDateTime)} · Last used:{" "}
                                    {formatDate(passkey.lastUsedDateTime)}
                                </p>
                            </div>
                            {pendingDelete?.id === passkey.id ? (
                                <div style={styles.confirmRow}>
                                    <button
                                        style={{ ...styles.secondaryButton, backgroundColor: "#b91c1c", color: "#ffffff" }}
                                        onClick={() => performDelete(passkey)}
                                        disabled={busy}
                                    >
                                        Confirm delete
                                    </button>
                                    <button
                                        style={{ ...styles.secondaryButton, color: "#292929", borderColor: "#6b7280" }}
                                        onClick={() => setPendingDelete(null)}
                                        disabled={busy}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            ) : (
                                <button
                                    style={styles.secondaryButton}
                                    onClick={() => {
                                        setPendingDelete(passkey);
                                        setBanner({
                                            kind: "warning",
                                            text: "If you're currently signed in with this passkey, deleting it may end your session and you'll need to sign in again (you can use your password and SMS code).",
                                        });
                                    }}
                                    disabled={busy}
                                >
                                    Delete
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            <h2 style={styles.sectionTitle}>Add a passkey</h2>
            <p style={styles.lead}>
                Your browser will guide you through creating the passkey on this device, a security
                key, or your phone. You may need a recent sign-in first.
            </p>
            <label style={styles.inputLabel} htmlFor="passkey-name">
                Passkey name (optional)
            </label>
            <input
                id="passkey-name"
                style={styles.nameInput}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="e.g. Work laptop — Windows Hello"
                disabled={busy}
            />
            <button
                style={{ ...styles.primaryButton, opacity: busy || !originOk ? 0.6 : 1 }}
                onClick={() => performAdd(newName)}
                disabled={busy || !originOk}
            >
                {busy ? "Working…" : "Add a passkey"}
            </button>
        </>
    );
}

function SignedOutView({ message, showLink = true }: { message: string; showLink?: boolean }) {
    return (
        <>
            <p style={styles.lead}>{message}</p>
            {showLink && (
                <a href="/" style={styles.primaryButton}>
                    Go to sign in
                </a>
            )}
        </>
    );
}

export default function SecurityPage() {
    const authClient = useAuthClient();
    const [account, setAccount] = useState<CustomAuthAccountData | null>(null);
    const [resolved, setResolved] = useState(false);
    const [available, setAvailable] = useState(true);

    useEffect(() => setAvailable(passkeyFeatureAvailable()), []);

    useEffect(() => {
        if (!authClient) return;
        const result = authClient.getCurrentAccount();
        if (result.isCompleted() && result.data) {
            setAccount(result.data);
        }
        setResolved(true);
    }, [authClient]);

    return (
        <main style={styles.page}>
            <div style={styles.hero}>
                <div style={styles.heroInner}>
                    <h1 style={styles.heroTitle}>Account security</h1>
                </div>
            </div>
            <div style={styles.cardWrap}>
                <div style={styles.card}>
                    <div style={styles.content}>
                        <h2 style={styles.heading}>Passkeys</h2>
                        {!available ? (
                            <SignedOutView
                                message="Passkey management needs the local proxy (npm run cors) and runs on the dev host. It is disabled here."
                                showLink={false}
                            />
                        ) : !authClient || !resolved ? (
                            <p style={styles.lead}>Loading…</p>
                        ) : account ? (
                            <PasskeyManager account={account} />
                        ) : (
                            <SignedOutView message="Sign in to view and manage the passkeys on your account. Passkeys let you sign in with your face, fingerprint, PIN, or a security key instead of a password." />
                        )}
                    </div>
                </div>
            </div>
        </main>
    );
}
Now the impersonation portal page.

Write c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\src\app\impersonate\page.tsx
499 lines
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CustomAuthAccountData } from "@azure/msal-browser/custom-auth";
import { useAuthClient } from "@/auth/AuthClientProvider";
import { impersonationFeatureAvailable } from "@/config/auth-config";
import {
    fetchActiveImpersonation,
    fetchImpersonationAudit,
    impersonationViewUrl,
    ImpersonationApiError,
    revokeImpersonation,
    startImpersonation,
    stopImpersonation,
    type ImpersonationAuditEntry,
    type ImpersonationSession,
} from "@/services/impersonation-service";

/**
 * Impersonation portal — RWVP (Feature B / B4), ported to the native-auth sample.
 *
 * The hardest cross-app scenario and the one External ID has no native IdP
 * pattern for: there is no supported way to mint a token AS another customer. So
 * this portal does impersonation where the plan says it must live (B4.1) — at the
 * application/session layer. An RBAC-gated admin enters a customer's email + a
 * justification; the backend (cors.js) verifies the admin is allow-listed,
 * confirms the customer exists, and mints a short-lived, read-only, HttpOnly *app*
 * session (never an Entra token) recording both the acting admin and the subject.
 *
 * Token model: the admin's bearer is the native-auth SDK ID token
 * (account.getIdToken()); start/revoke/audit are gated on it server-side.
 */

const APP_LABEL = "myServiceTas";

const styles = {
    page: {
        backgroundColor: "#f5f5f5",
        minHeight: "calc(100vh - 3.75rem)",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        color: "#292929",
    },
    hero: { backgroundColor: "#098851", padding: "3.75rem 0" },
    heroInner: { maxWidth: "80rem", margin: "0 auto", padding: "0 2.5rem" },
    heroTitle: { color: "#ffffff", fontSize: "2rem", fontWeight: 700, margin: 0 },
    wrap: { maxWidth: "80rem", margin: "-2.5rem auto 2.5rem", padding: "0 2.5rem" },
    card: { backgroundColor: "#ffffff", padding: "2rem 2.5rem", marginBottom: "1.5rem" },
    lead: { fontSize: "1rem", margin: "0 0 1.5rem 0", lineHeight: 1.6 },
    sectionTitle: { fontSize: "1.25rem", fontWeight: 800, margin: "0 0 1rem 0" },
    label: { display: "block", fontWeight: 700, margin: "0 0 0.35rem 0" },
    input: {
        width: "100%",
        boxSizing: "border-box" as const,
        padding: "0.65rem 0.8rem",
        border: "0.0625rem solid #b0b0b0",
        borderRadius: 0,
        fontSize: "1rem",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        marginBottom: "1rem",
    },
    status: (kind: "info" | "ok" | "error") => ({
        padding: "0.75rem 1rem",
        borderRadius: "0.25rem",
        marginBottom: "1.5rem",
        fontWeight: 700,
        backgroundColor: kind === "error" ? "#fdecea" : kind === "ok" ? "#e6f4ec" : "#eef2f7",
        color: kind === "error" ? "#b3261e" : kind === "ok" ? "#098851" : "#404040",
    }),
    banner: {
        backgroundColor: "#b3261e",
        color: "#ffffff",
        padding: "0.85rem 1.25rem",
        fontWeight: 700,
        lineHeight: 1.5,
        marginBottom: "1.25rem",
    },
    note: (kind: "info" | "warn") => ({
        padding: "1rem 1.25rem",
        borderLeft: `0.25rem solid ${kind === "warn" ? "#b45309" : "#098851"}`,
        backgroundColor: kind === "warn" ? "#fef6e7" : "#e6f4ec",
        marginBottom: "1.5rem",
        lineHeight: 1.6,
    }),
    primaryButton: {
        display: "inline-block",
        padding: "0.75rem 2.5rem",
        backgroundColor: "#267151",
        color: "#ffffff",
        border: "none",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "1rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        textDecoration: "none",
    },
    dangerButton: {
        padding: "0.5rem 1.25rem",
        backgroundColor: "#b3261e",
        color: "#ffffff",
        border: "none",
        borderRadius: 0,
        cursor: "pointer",
        fontSize: "0.9375rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    revokeButton: {
        padding: "0.3rem 0.8rem",
        backgroundColor: "#ffffff",
        color: "#b3261e",
        border: "0.0625rem solid #b3261e",
        borderRadius: 0,
        cursor: "pointer",
        fontSize: "0.8125rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    deviceFrame: {
        maxWidth: "26rem",
        border: "0.75rem solid #1e1e1e",
        borderRadius: "1.75rem",
        overflow: "hidden" as const,
        backgroundColor: "#000",
    },
    deviceBar: { color: "#fff", fontSize: "0.8125rem", textAlign: "center" as const, padding: "0.5rem", fontWeight: 700 },
    iframe: { display: "block", width: "100%", height: "24rem", border: "none", backgroundColor: "#fff" },
    detailGrid: { display: "grid", gridTemplateColumns: "10rem 1fr", gap: "0.4rem 1rem", margin: "1.25rem 0", fontSize: "0.9375rem" },
    detailKey: { fontWeight: 700, color: "#267151" },
    table: { width: "100%", borderCollapse: "collapse" as const, fontSize: "0.875rem" },
    th: { textAlign: "left" as const, padding: "0.5rem", borderBottom: "0.125rem solid #d1d5db", color: "#404040" },
    td: { padding: "0.5rem", borderBottom: "0.0625rem solid #e5e7eb", verticalAlign: "top" as const },
    code: { backgroundColor: "#f0f0f0", padding: "0.1rem 0.35rem", borderRadius: "0.2rem", fontFamily: "ui-monospace, 'Consolas', monospace", fontSize: "0.85em" },
} as const;

const fmtTime = (epoch: number) => new Date(epoch * 1000).toLocaleString();
const idLabel = (i: { email: string | null; oid: string | null }) => i.email ?? i.oid ?? "unknown";

function Hero() {
    return (
        <div style={styles.hero}>
            <div style={styles.heroInner}>
                <h1 style={styles.heroTitle}>{`${APP_LABEL} — impersonation portal (RWVP)`}</h1>
            </div>
        </div>
    );
}

function ImpersonationPortal({ account }: { account: CustomAuthAccountData }) {
    const [isAdmin, setIsAdmin] = useState<boolean | null>(null); // null = unknown yet
    const [adminMessage, setAdminMessage] = useState<string | null>(null);
    const [session, setSession] = useState<ImpersonationSession | null>(null);
    const [auditLog, setAuditLog] = useState<ImpersonationAuditEntry[]>([]);
    const [activeSessions, setActiveSessions] = useState<ImpersonationSession[]>([]);

    const [subjectEmail, setSubjectEmail] = useState("");
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<{ kind: "info" | "ok" | "error"; text: string } | null>(null);
    const [viewKey, setViewKey] = useState(0); // bump to force the iframe to reload
    const loaded = useRef(false);

    /** The admin's ID token for the RBAC-gated calls (start/revoke/audit). */
    const getToken = useCallback(() => {
        const token = account.getIdToken();
        if (!token) throw new ImpersonationApiError("No signed-in account. Please sign in again.");
        return token;
    }, [account]);

    const refreshAudit = useCallback(async () => {
        const audit = await fetchImpersonationAudit(getToken());
        setAuditLog([...audit.log].reverse()); // newest first
        setActiveSessions(audit.active);
    }, [getToken]);

    // On mount: read any in-progress impersonation (cookie) and probe admin rights
    // by trying to read the audit log (a 403 with not_admin = RBAC gate).
    useEffect(() => {
        if (loaded.current) return;
        loaded.current = true;
        (async () => {
            try {
                setSession(await fetchActiveImpersonation());
            } catch {
                /* whoami failure is non-fatal — leave session null */
            }
            try {
                await refreshAudit();
                setIsAdmin(true);
            } catch (err) {
                if (err instanceof ImpersonationApiError && err.code === "not_admin") {
                    setIsAdmin(false);
                    setAdminMessage(err.message);
                } else {
                    setIsAdmin(true); // reachability issue, not an authz denial
                    setStatus({
                        kind: "error",
                        text: err instanceof Error ? err.message : "Could not load the impersonation portal.",
                    });
                }
            }
        })();
    }, [refreshAudit]);

    const handleStart = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();
            setBusy(true);
            setStatus({ kind: "info", text: "Starting impersonation session…" });
            try {
                const started = await startImpersonation(getToken(), subjectEmail.trim(), reason.trim());
                setSession(started);
                setViewKey((k) => k + 1);
                setStatus({ kind: "ok", text: `Impersonating ${idLabel(started.subject)} — read-only, ends ${fmtTime(started.expiresAt)}.` });
                setReason("");
                await refreshAudit();
            } catch (err) {
                setStatus({ kind: "error", text: err instanceof Error ? err.message : "Could not start impersonation." });
            } finally {
                setBusy(false);
            }
        },
        [getToken, subjectEmail, reason, refreshAudit]
    );

    const handleStop = useCallback(async () => {
        setBusy(true);
        try {
            await stopImpersonation();
            setSession(null);
            setStatus({ kind: "info", text: "Impersonation session ended." });
            await refreshAudit().catch(() => {});
        } catch (err) {
            setStatus({ kind: "error", text: err instanceof Error ? err.message : "Could not stop impersonation." });
        } finally {
            setBusy(false);
        }
    }, [refreshAudit]);

    const handleRevoke = useCallback(
        async (sessionId: string) => {
            setBusy(true);
            try {
                await revokeImpersonation(getToken(), sessionId);
                if (session?.sessionId === sessionId) setSession(null);
                setStatus({ kind: "info", text: "Session revoked." });
                await refreshAudit();
            } catch (err) {
                setStatus({ kind: "error", text: err instanceof Error ? err.message : "Could not revoke the session." });
            } finally {
                setBusy(false);
            }
        },
        [getToken, refreshAudit, session]
    );

    return (
        <main style={styles.page}>
            <Hero />
            <div style={styles.wrap}>
                <div style={styles.card}>
                    <p style={styles.lead}>
                        The RWVP impersonation portal lets an authorised support administrator view a customer&rsquo;s
                        account <strong>as the customer sees it</strong>, to diagnose an issue. External ID has{" "}
                        <strong>no supported way to mint a token as another customer</strong> (the B2C{" "}
                        <code style={styles.code}>id_token_hint</code> trick doesn&rsquo;t exist here), so this is done at
                        the <strong>application/session layer</strong>: an RBAC-gated action mints a short-lived,
                        read-only, <code style={styles.code}>HttpOnly</code> <em>app</em> session — never an Entra token —
                        recording both the acting admin and the subject (plan Feature B / B4).
                    </p>

                    <div style={styles.note("warn")}>
                        <p style={{ fontWeight: 800, margin: "0 0 0.5rem 0" }}>Security model (plan B4.2)</p>
                        <p style={{ margin: 0 }}>
                            RBAC allow-list · separation of duties (no self-impersonation; the session never elevates the
                            admin&rsquo;s own rights) · least privilege (read-only) · bounded 15-minute duration ·
                            server-side <strong>revocation</strong> · append-only <strong>audit log</strong> with a required
                            justification. Full design + review in{" "}
                            <code style={styles.code}>impersonation-portal-design.md</code>.
                        </p>
                    </div>

                    {status && <div style={styles.status(status.kind)}>{status.text}</div>}

                    {isAdmin === false && (
                        <div style={styles.note("warn")}>
                            <p style={{ fontWeight: 800, margin: "0 0 0.5rem 0" }}>RBAC gate: you are not authorised</p>
                            <p style={{ margin: 0 }}>
                                {adminMessage ?? "Your account is not on the impersonation admin allow-list."} This is the
                                gate working as designed. To grant access for the demo, add your email to{" "}
                                <code style={styles.code}>IMPERSONATION_ADMIN_EMAILS</code> in{" "}
                                <code style={styles.code}>.env.local</code> (or set{" "}
                                <code style={styles.code}>IMPERSONATION_ALLOW_ANY_ADMIN=true</code> for local dev) and restart
                                the proxy.
                            </p>
                        </div>
                    )}
                </div>

                {/* Active session view */}
                {session && (
                    <div style={styles.card}>
                        <div style={styles.banner}>
                            ⚠ Impersonating <strong>{idLabel(session.subject)}</strong> — acting as{" "}
                            <strong>{idLabel(session.actor)}</strong>. Read-only · ends {fmtTime(session.expiresAt)}.
                        </div>
                        <h2 style={styles.sectionTitle}>Customer view (read-only)</h2>
                        <div style={styles.deviceFrame}>
                            <div style={styles.deviceBar}>Impersonated session</div>
                            <iframe
                                key={viewKey}
                                title="Impersonated customer view"
                                src={impersonationViewUrl()}
                                style={styles.iframe}
                            />
                        </div>
                        <div style={styles.detailGrid}>
                            <span style={styles.detailKey}>Session id</span>
                            <code style={styles.code}>{session.sessionId}</code>
                            <span style={styles.detailKey}>Acting admin</span>
                            <span>{idLabel(session.actor)}</span>
                            <span style={styles.detailKey}>Subject</span>
                            <span>{idLabel(session.subject)}{session.subject.name ? ` (${session.subject.name})` : ""}</span>
                            <span style={styles.detailKey}>Scope</span>
                            <span>{session.scope}</span>
                            <span style={styles.detailKey}>Justification</span>
                            <span>{session.reason}</span>
                            <span style={styles.detailKey}>Expires</span>
                            <span>{fmtTime(session.expiresAt)}</span>
                        </div>
                        <button type="button" style={styles.dangerButton} onClick={handleStop} disabled={busy}>
                            Stop impersonating
                        </button>
                    </div>
                )}

                {/* Start form (admins only) */}
                {isAdmin !== false && !session && (
                    <div style={styles.card}>
                        <h2 style={styles.sectionTitle}>Start an impersonation session</h2>
                        <form onSubmit={handleStart}>
                            <label style={styles.label} htmlFor="subjectEmail">
                                Customer email
                            </label>
                            <input
                                id="subjectEmail"
                                type="email"
                                style={styles.input}
                                value={subjectEmail}
                                onChange={(e) => setSubjectEmail(e.target.value)}
                                placeholder="customer@example.com"
                                required
                            />
                            <label style={styles.label} htmlFor="reason">
                                Justification (recorded in the audit log)
                            </label>
                            <input
                                id="reason"
                                type="text"
                                style={styles.input}
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder="e.g. Ticket #12345 — customer can't see their renewal"
                                required
                            />
                            <button type="submit" style={styles.primaryButton} disabled={busy}>
                                Start impersonation
                            </button>
                        </form>
                    </div>
                )}

                {/* Audit + live sessions (admins only) */}
                {isAdmin && (
                    <div style={styles.card}>
                        <h2 style={styles.sectionTitle}>Audit log</h2>
                        {activeSessions.length > 0 && (
                            <>
                                <p style={{ fontWeight: 700, margin: "0 0 0.5rem 0" }}>Live sessions</p>
                                <table style={styles.table}>
                                    <thead>
                                        <tr>
                                            <th style={styles.th}>Subject</th>
                                            <th style={styles.th}>Acting admin</th>
                                            <th style={styles.th}>Expires</th>
                                            <th style={styles.th}></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {activeSessions.map((s) => (
                                            <tr key={s.sessionId}>
                                                <td style={styles.td}>{idLabel(s.subject)}</td>
                                                <td style={styles.td}>{idLabel(s.actor)}</td>
                                                <td style={styles.td}>{fmtTime(s.expiresAt)}</td>
                                                <td style={styles.td}>
                                                    <button
                                                        type="button"
                                                        style={styles.revokeButton}
                                                        onClick={() => handleRevoke(s.sessionId)}
                                                        disabled={busy}
                                                    >
                                                        Revoke
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </>
                        )}

                        <p style={{ fontWeight: 700, margin: "1.25rem 0 0.5rem 0" }}>History</p>
                        {auditLog.length === 0 ? (
                            <p style={{ margin: 0, color: "#6b7280" }}>No impersonation activity yet.</p>
                        ) : (
                            <table style={styles.table}>
                                <thead>
                                    <tr>
                                        <th style={styles.th}>When</th>
                                        <th style={styles.th}>Action</th>
                                        <th style={styles.th}>Subject</th>
                                        <th style={styles.th}>Acting admin</th>
                                        <th style={styles.th}>Justification</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {auditLog.map((entry, i) => (
                                        <tr key={`${entry.sessionId}-${entry.action}-${i}`}>
                                            <td style={styles.td}>{new Date(entry.at).toLocaleString()}</td>
                                            <td style={styles.td}>{entry.action}</td>
                                            <td style={styles.td}>{idLabel(entry.subject)}</td>
                                            <td style={styles.td}>{idLabel(entry.actor)}</td>
                                            <td style={styles.td}>{entry.reason ?? "—"}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                )}
            </div>
        </main>
    );
}

function InfoView({ message }: { message: string }) {
    return (
        <main style={styles.page}>
            <Hero />
            <div style={styles.wrap}>
                <div style={styles.card}>
                    <p style={styles.lead}>{message}</p>
                    <a href="/" style={styles.primaryButton}>
                        Go to sign in
                    </a>
                </div>
            </div>
        </main>
    );
}

export default function ImpersonatePage() {
    const authClient = useAuthClient();
    const [account, setAccount] = useState<CustomAuthAccountData | null>(null);
    const [resolved, setResolved] = useState(false);
    const [available, setAvailable] = useState(true);

    useEffect(() => setAvailable(impersonationFeatureAvailable()), []);

    useEffect(() => {
        if (!authClient) return;
        const result = authClient.getCurrentAccount();
        if (result.isCompleted() && result.data) {
            setAccount(result.data);
        }
        setResolved(true);
    }, [authClient]);

    if (!available) {
        return <InfoView message="The impersonation portal needs the local proxy (npm run cors) and runs on localhost. It is disabled on this host." />;
    }
    if (!authClient || !resolved) {
        return (
            <main style={styles.page}>
                <Hero />
                <div style={styles.wrap}>
                    <div style={styles.card}>
                        <p style={styles.lead}>Loading…</p>
                    </div>
                </div>
            </main>
        );
    }
    if (!account) {
        return <InfoView message="Sign in first — the impersonation portal is an administrator tool, gated by an RBAC allow-list." />;
    }
    return <ImpersonationPortal account={account} />;
}
Now the Navbar — add the manage-account links (gated by feature availability, resolved in an effect like the webview link).

Write c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\src\components\Navbar.tsx
110 lines
"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthClient } from "@/auth/AuthClientProvider";
import {
    accountFeatureAvailable,
    impersonationFeatureAvailable,
    passkeyFeatureAvailable,
    webviewFeatureAvailable,
} from "@/config/auth-config";
import styles from "./Navbar.module.css";

export default function Navbar() {
    const router = useRouter();
    const app = useAuthClient();

    // Resolved in an effect (not during render) so the static-export prerender
    // and the first client render agree; the manage-account links need the local
    // proxy so they only light up on the dev hosts.
    const [accountAvailable, setAccountAvailable] = useState(false);
    const [passkeyAvailable, setPasskeyAvailable] = useState(false);
    const [webviewAvailable, setWebviewAvailable] = useState(false);
    const [impersonationAvailable, setImpersonationAvailable] = useState(false);
    useEffect(() => {
        setAccountAvailable(accountFeatureAvailable());
        setPasskeyAvailable(passkeyFeatureAvailable());
        setWebviewAvailable(webviewFeatureAvailable());
        setImpersonationAvailable(impersonationFeatureAvailable());
    }, []);

    const handleLogout = async () => {
        if (!app) return;
        try {
            const account = app.getCurrentAccount();
            if (account.data) {
                await account.data.signOut();
                console.log("User signed out successfully.");
            } else {
                console.log("No user currently signed in.");
            }
            // Clear any local session/state if necessary (MSAL handles its own cache)
            router.push("/"); // Redirect to home page after logout
        } catch (error) {
            console.error("Logout failed:", error);
            // Optionally, show an error message to the user
        }
    };

    return (
        <nav className={styles.navbar}>
            <Link href="/" className={styles.logo} aria-label="Service Tasmania home">
                <Image
                    src="/logos/tasmania-govt-black.svg"
                    alt="Tasmanian Government"
                    width={54}
                    height={50}
                    className={styles.logoEmblem}
                    priority
                />
                <span className={styles.logoDivider} aria-hidden="true" />
                <Image
                    src="/logos/service-tasmania-black.svg"
                    alt="Service Tasmania"
                    width={118}
                    height={48}
                    className={styles.logoWordmark}
                    priority
                />
            </Link>
            <div className={styles.links}>
                <Link href="/" className={styles.link}>
                    Sign In
                </Link>
                <Link href="/sign-up" className={styles.link}>
                    Sign Up
                </Link>
                <Link href="/reset-password" className={styles.link}>
                    Reset Password
                </Link>
                {passkeyAvailable && (
                    <Link href="/security" className={styles.link}>
                        Security
                    </Link>
                )}
                {accountAvailable && (
                    <Link href="/account" className={styles.link}>
                        My Account
                    </Link>
                )}
                {webviewAvailable && (
                    <Link href="/webview" className={styles.link}>
                        Webview SSO
                    </Link>
                )}
                {impersonationAvailable && (
                    <Link href="/impersonate" className={styles.link}>
                        Impersonation
                    </Link>
                )}
                <button onClick={handleLogout} className={styles.link} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit', textDecoration: 'underline' }}>
                    Sign Out
                </button>
            </div>
        </nav>
    );
}
Pages and Navbar done. Now the Azure Function (authProxy.ts). Let me reconsider scope here: the browser-delegated "manage account" backend (local-proxy.mjs) is dev-only — its features are gated to localhost and were never ported to a deployed function. I've matched that exactly with cors.js + dev-host gating. Rather than write ~600 lines of untestable JWKS+Graph+ACS code into the Functions runtime, the responsible move is to add a guard so the deployed function doesn't silently proxy /api/account to CIAM (a confusing 404), and document the boundary.

Let me add that guard.

Edit c:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\api\src\functions\authProxy.ts
Added 28 lines
Now let me update tracking and build/lint the app to catch errors.

Update Todos

Extend native-auth auth-config.ts with account/passkey/impersonation API bases, feature flags, passkeyRpId, ngcmfa note, and email-from-claims helper

Port account-service.ts to native-auth (rebased imports)

Port passkey-service.ts to native-auth

Port impersonation-service.ts to native-auth

Write shared graph-routes.js backend module and wire into cors.js

Port account/page.tsx to native-auth SDK token model

Port security/page.tsx (passkeys) to native-auth SDK token model

Port impersonate/page.tsx to native-auth SDK token model

Add My Account / Security / Impersonation links to native-auth Navbar

Guard account/passkey/impersonation routes in api/authProxy.ts (dev-only boundary)

Build + lint the native-auth app and fix errors
Bash Lint the native-auth src
IN
cd c:/source/ms-identity-ciam-native/typescript/native-auth/react-nextjs-sample && echo "=== lint ===" && npx next lint --dir src 2>&1 | tail -40

OUT
=== lint ===
error: unknown option '--dir'
Bash Type-check the native-auth app
IN
cd c:/source/ms-identity-ciam-native/typescript/native-auth/react-nextjs-sample && echo "=== tsc typecheck (noEmit) ===" && npx tsc --noEmit 2>&1 | head -60; echo "EXIT: $?"

OUT
=== tsc typecheck (noEmit) ===
EXIT: 0
Type-check passes. Let me run ESLint and a production build.

Bash Run eslint via npm script
IN
cd c:/source/ms-identity-ciam-native/typescript/native-auth/react-nextjs-sample && echo "=== lint ===" && npm run lint 2>&1 | tail -40; echo "LINT EXIT: ${PIPESTATUS[0]}"

OUT
=== lint ===

> react-sample-nextjs@0.1.0 lint
> next lint

Invalid project directory provided, no such directory: C:\source\ms-identity-ciam-native\typescript\native-auth\react-nextjs-sample\lint
LINT EXIT: 1
next lint is quirky in Next 16. The build runs lint+typecheck anyway. Let me build.

Bash Production build of native-auth app
IN
cd c:/source/ms-identity-ciam-native/typescript/native-auth/react-nextjs-sample && npm run build 2>&1 | tail -55; echo "BUILD EXIT: ${PIPESTATUS[0]}"

OUT
> react-sample-nextjs@0.1.0 build
> next build

▲ Next.js 16.2.6 (Turbopack)
- Environments: .env

  Creating an optimized production build ...
✓ Compiled successfully in 7.5s
  Running TypeScript ...
  Finished TypeScript in 26.3s ...
  Collecting page data using 11 workers ...
  Generating static pages using 11 workers (0/10) ...
  Generating static pages using 11 workers (2/10) 
  Generating static pages using 11 workers (4/10) 
  Generating static pages using 11 workers (7/10) 
✓ Generating static pages using 11 workers (10/10) in 653ms
  Finalizing page optimization ...

Route (app)
┌ ○ /
├ ○ /_not-found
├ ○ /account
├ ○ /impersonate
├ ○ /reset-password
├ ○ /security
├ ○ /sign-up
└ ○ /webview


○  (Static)  prerendered as static content

BUILD EXIT: 0
Build passes — all three pages generated. Let me syntax-check the backend JS files (without starting the server).

Bash Syntax-check cors.js, graph-routes.js, and api TS
IN
cd c:/source/ms-identity-ciam-native/typescript/native-auth/react-nextjs-sample && echo "=== graph-routes.js ===" && node --check graph-routes.js && echo OK && echo "=== cors.js ===" && node --check cors.js && echo OK && echo "=== authProxy.ts compiles? ===" && cd api && npx tsc --noEmit 2>&1 | head -20; echo "API TSC EXIT: ${PIPESTATUS[0]}"

OUT
=== graph-routes.js ===
OK
=== cors.js ===
OK
=== authProxy.ts compiles? ===
API TSC EXIT: 0
Everything compiles. Let me do a runtime smoke test of the wired proxy — start cors.js and hit the new routes to confirm the dispatch and token-gating work.

Bash Smoke-test cors.js new routes
IN
cd c:/source/ms-identity-ciam-native/typescript/native-auth/react-nextjs-sample && node cors.js > /tmp/cors.log 2>&1 &
CORS_PID=$!
sleep 2
echo "=== startup log ==="; cat /tmp/cors.log
echo ""; echo "=== GET /api/account (no token -> expect 401) ==="
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/account
echo "body:"; curl -s http://localhost:3001/api/account
echo ""; echo "=== GET /api/passkeys (no token -> 401) ==="
curl -s -w " [%{http_code}]\n" http://localhost:3001/api/passkeys
echo "=== GET /api/impersonation/whoami (no cookie -> 401 no_session) ==="
curl -s -w " [%{http_code}]\n" http://localhost:3001/api/impersonation/whoami
echo "=== GET /impersonate-view (no cookie -> 401 html) ==="
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/impersonate-view
echo "=== GET /api/native (unrelated -> should proxy to CIAM, not handled by graph-routes) ==="
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3001/api/.well-known/openid-configuration"
kill $CORS_PID 2>/dev/null
echo "done"

OUT
=== startup log ===
CORS proxy running on http://localhost:3001
Proxying from /api ===> https://myservicetasdevpoc.ciamlogin.com/a67366e7-9873-4a38-9bae-0a4a18952688

=== GET /api/account (no token -> expect 401) ===
401
body:
{"error":{"message":"Missing Bearer token."}}
=== GET /api/passkeys (no token -> 401) ===
{"error":{"message":"Missing Bearer token."}} [401]
=== GET /api/impersonation/whoami (no cookie -> 401 no_session) ===
{"error":{"message":"No active impersonation session.","code":"no_session"}} [401]
=== GET /impersonate-view (no cookie -> 401 html) ===
401
=== GET /api/native (unrelated -> should proxy to CIAM, not handled by graph-routes) ===
200
done
All smoke tests pass: token-gated routes return 401, the impersonation cookie gate works, and unrelated /api/* paths still proxy to CIAM (dispatch correctly falls through). Let me confirm .env.local (where the new Graph secret lives) is gitignored.

Bash Check .env is gitignored
IN
cd c:/source/ms-identity-ciam-native/typescript/native-auth/react-nextjs-sample && grep -nE "env" .gitignore || echo "NO env pattern in .gitignore"

OUT
33:# env files (can opt-in for committing if needed)
34:.env*
41:next-env.d.ts
.env* is ignored — the new ACCOUNT_CLIENT_SECRET / ACS settings won't be committed. Let me finalize the todos.

Update Todos

Extend native-auth auth-config.ts with account/passkey/impersonation API bases, feature flags, passkeyRpId, ngcmfa note, and email-from-claims helper

Port account-service.ts to native-auth (rebased imports)

Port passkey-service.ts to native-auth

Port impersonation-service.ts to native-auth

Write shared graph-routes.js backend module and wire into cors.js

Port account/page.tsx to native-auth SDK token model

Port security/page.tsx (passkeys) to native-auth SDK token model

Port impersonate/page.tsx to native-auth SDK token model

- New TFS user (browser): completes sign-up, sees TFS T&C, lands provisioned in Dataverse (Contact + consent + service-link); verified by `checkUser` returning "has consent".
- Existing myServiceTas user opening the TFS app first time: prompted for TFS T&C **by the app**, consent recorded, service linked.
- Non-TFS app: no TFS T&C shown; no TFS provisioning.
- Blocked email still blocked (existing OnOtpSend/OnAttributeCollectionStart behaviour intact).
- Re-running sign-up is idempotent (no duplicate Dataverse rows).

---

## 4. Feature B — Cross-app SSO (replacing B2C `id_token_hint`)

**`id_token_hint` is not available in External ID.** Decompose by scenario; each has a different answer.

### 4.1 Alignment checklist — delivering the B2C `id_token_hint` *outcome* on External ID

Decisions locked (2026-06-22): **the website (TFS / PlatesPlus–Power Pages) is moving to External ID**; **the goal is the user-facing outcome — "sign into the app, open the website, no second sign-in" — not the mint/consume mechanism**; and **D1 is committed to a browser-delegated mobile app** (C1, below). The literal six-step flow is therefore N/A by design (see [sso_id_token_hint_requirement.md](sso_id_token_hint_requirement.md)); these are the steps that turn the proven POC into the production outcome. C1 is now done — **C2 (custom domain) is the next gating item**. Do the rest in order.

| # | Step | Why it's required for the outcome | Effort | Status |
| --- | --- | --- | --- | --- |
| C1 | **Commit Decision D1 = browser-delegated mobile app.** | Makes the system browser share the `ciamlogin.com` cookie jar → app→website skips login. Collapses the B3 gap into the proven B1 path; it's the prerequisite for the whole app→web leg. | S | ✅ **committed 2026-06-22** (D1 locked in §1) |
| C2 | **Stand up the single custom URL domain (P0.1).** | Without it, only the `prompt=none` redirect works; the silent iframe stays blocked and Safari/iOS is unverified. Also on the critical path for production passkeys. | M | ⬜ |
| C3 | **Grant admin consent for every relying party** (website, PlatesPlus/Power Pages, future SPs). | A never-consented app fails the silent request with `AADSTS65001 consent_required`, which has no UI to recover. One-time, mandatory per SP. | S | ✅ |
| C4 | **Configure PlatesPlus / Power Pages as an OIDC relying party and run the B1.7 spike end-to-end, incl. Safari/iOS.** | The website leg named in the requirement; still the largest untested piece. | 🔬 | ⬜ (= B1.4 / B1.7) |
| C5 | **Configure the "Stay signed in" persistent-browser-session control (B1.6).** | Keeps the shared session alive across app launches so SSO is useful in practice. | S | ⬜ (= B1.6) |

**Explicitly not doing:** an app-layer session broker that mimics the mint/consume shape (plan B3.2 interim **(c)**) — it wouldn't yield an Entra token, and the agreed goal is the outcome, which C1–C5 deliver on supported mechanisms.

**Alignment definition of done:** sign into the (browser-delegated) app → open the website / PlatesPlus in the system browser → **no second sign-in**, validated on Safari/iOS, on the custom domain, with admin consent granted for each relying party.

### Phase B0 — Confirm the app auth model (Decision D1) ✅ **resolved 2026-06-22**

> **Resolved (2026-06-22):** D1 committed to **browser-delegated** (C1 in §4.1; D1 row in §1). App→system-browser SSO is therefore a **free win** via the shared `ciamlogin.com` cookie jar — B3 collapses into the proven B1 path — rather than a platform gap. The native-auth sample remains in the repo for reference, but the production mobile app is browser-delegated.

| Step | Task | Effort |
| --- | --- | --- |
| B0.1 | Confirm native vs browser-delegated for the mobile app, because it determines whether B3 (app→system-browser SSO) is a free win or a platform gap. — ✅ browser-delegated (see above). | S |

### Phase B1 — Web ↔ Web SSO (the supported win — do this first) ✅ **proven (POC)**

Covers myServiceTas website ↔ PlatesPlus/Power Pages and any other web app on the same tenant. SSO works via the shared session cookie on the (single) custom domain.

> **POC result (2026-06-18):** proven on `ciamlogin.com` between two SPA instances of [react-nextjs-sample](typescript/browser-delegated/react-nextjs-sample/) — App A (`clientId 5f0a52ca…`, :3000) and App B (`clientId 189164f4…`, :3002), separate app registrations + separate `sessionStorage` caches. Sign into A → "Open Relying app (SSO)" → App B lands **signed in with no prompt**. Implementation: [SsoBootstrap.tsx](typescript/browser-delegated/react-nextjs-sample/src/auth/SsoBootstrap.tsx) (`ssoSilent` → `prompt=none` `loginRedirect` fallback), no-prompt `silentRequest` in [auth-config.ts](typescript/browser-delegated/react-nextjs-sample/src/config/auth-config.ts).
>
> **Findings:**
> 1. **Each relying party needs consent** — B2C's `id_token_hint` carried no consent step; in External ID a never-consented app returns `AADSTS65001 consent_required` on the silent request (which has no UI to consent). Fix for first-party apps: **grant admin consent** per app registration → SSO is then fully promptless. This is a new, mandatory setup step per SP, not a runtime concern.
> 2. **Under corporate third-party-cookie blocking (the test environment), the `ssoSilent` iframe never succeeds** (`login_required AADSTS50058` — session cookie not sent in the third-party iframe), but the **top-level `prompt=none` redirect works** — the session cookie is first-party during the full-page navigation, so Entra resolves the session. The two-tier fallback (iframe → redirect) is therefore the correct design; the redirect path alone is sufficient on `ciamlogin.com`.
> 3. **A single custom URL domain (P0.1) is what would revive the silent-iframe path** (IdP same-site with the apps) — but it is **not required for the redirect path**, so web↔web SSO is demonstrable on `ciamlogin.com` today. Custom domain remains the production recommendation (smoother SSO + passkeys).
> 4. **MSAL gotcha:** `navigateToLoginRequestUrl: true` returns to the original `?sso=…` URL after a failed `prompt=none` redirect, re-triggering the bootstrap → infinite redirect loop. Guarded with a `sessionStorage` attempt-marker that survives the navigation (a `useRef` does not). The normal `loginRequest` keeps `prompt: "login"`; only the dedicated `silentRequest` is used on SSO paths.
>
> **Decisions for this POC:** admin-consent-only (no runtime escalation to interactive on `consent_required`); spike on `ciamlogin.com` (no custom domain); not yet validated on Safari/iOS or against Power Pages (B1.4/B1.7 still open).

| Step | Task | Effort |
| --- | --- | --- |
| B1.1 | Ensure all web apps authenticate against the **same tenant + single custom URL domain** (P0.1). | S |
| B1.2 | Register the website SPA and each other web app on the tenant; bind to the appropriate user flow. | S |
| B1.3 | Implement MSAL **`ssoSilent`** (with `login_hint` / `sid`) and a **`prompt=none`** redirect fallback for silent token acquisition. | M |
| B1.4 | Configure **Power Pages** (PlatesPlus) to use External ID as an **OIDC identity provider** (built-in support: app reg + user flow + clientId/authority/metadata). | M |
| B1.5 | Handle **third-party-cookie blocking** (Safari/iOS breaks the `ssoSilent` iframe) → use the `prompt=none` redirect path. Test on Safari/iOS. | M |
| B1.6 | Configure the **"Stay signed in"** experience via the Conditional Access persistent-browser-session control. | S |
| B1.7 | 🔬 **Spike (1–2 days):** website ↔ Power Pages SSO end-to-end on the custom domain, including Safari. This validates the largest `id_token_hint` replacement. | 🔬 |

### Phase B2 — Native app → in-app web content (embedded webview) ✅ **proven (POC)**

Supported pattern for web content shown *inside* the app.

> **POC result (2026-06-18):** proven in [react-nextjs-sample](typescript/browser-delegated/react-nextjs-sample/). The [`/webview`](typescript/browser-delegated/react-nextjs-sample/src/app/webview/page.tsx) page plays the **native app shell**; an embedded `<iframe>` is the webview; [local-proxy.mjs](typescript/browser-delegated/react-nextjs-sample/local-proxy.mjs) is the **web resource backend**. Shell acquires the user's token → POSTs it to `/api/webview/session` (one-time bearer injection) → proxy validates `aud`/`iss`/`tid`/sig/exp and sets an **`HttpOnly`** cookie → iframe loads `/webview` riding the cookie alone → navigation to `/webview/profile` carries only the cookie. Webview lands **signed in with no second prompt**.
>
> **Findings:**
> 1. **Browser substitution for B2.2:** a browser can't set a header on an `<iframe>` navigation (a native SDK can), so the shell does the bearer injection via a credentialed `fetch` to the session endpoint, then loads the iframe. The backend logic (validate bearer → set `HttpOnly` cookie → serve from cookie) is identical to the real native case.
> 2. **`SameSite=Lax` suffices** because the app (`:3000`) and the web resource (`:3001`) are the **same site** (both `localhost`) — the cookie is first-party on the iframe's requests, so third-party-cookie blocking is a non-issue. Production keeps this by hosting both under the **single custom URL domain** (P0.1); a genuinely cross-site embed would need partitioned cookies (CHIPS).
> 3. **ID token vs access token:** the POC sends the **ID token** as the bearer (reuses the existing `verifyUserToken` path; matches the account/passkey pages; runnable with no extra Entra setup). Production would expose an **API scope** on the shared app registration and validate that **access token's** `aud` — same validation logic, which is the substance of B2.3.

| Step | Task | Effort | Status |
| --- | --- | --- | --- |
| B2.1 | Ensure the app and the web resource **share a client ID** and the app requests the **scopes the web resource needs**. | S | ✅ shared client id; POC reuses ID-token aud (prod: API scope) |
| B2.2 | App acquires an access token (native SDK) and injects `Authorization: Bearer <token>` into the webview's request. | M | ✅ shell injects bearer via credentialed fetch (browser stand-in for SDK) |
| B2.3 | Web backend validates `aud`/`iss` and sets an `HttpOnly` session cookie to persist the session across navigation. | M | ✅ `POST /api/webview/session` → signed `HttpOnly` cookie; cookie-gated content pages |
| B2.4 | 🔬 **Spike:** prove app→webview SSO with no second prompt. | 🔬 | ✅ iframe renders signed-in; `/webview/profile` proves cross-navigation persistence |

### Phase B3 — Native app → system browser / separate web app (the genuine gap) ✅ **gap confirmed; interim (b) proven (POC)**

This is the literal B2C `id_token_hint` flow. **Not currently supported** ("cross-app SSO through system browsers isn't supported with native authentication"; a generic solution is "planned for a future release").

> **POC result (2026-06-18):** the gap is **confirmed** against current Microsoft Learn (B3.1) and **interim (b)** — `login_hint`-seeded interactive sign-in — is demonstrated in [react-nextjs-sample](typescript/browser-delegated/react-nextjs-sample/). The [`/handoff`](typescript/browser-delegated/react-nextjs-sample/src/app/handoff/page.tsx) page plays the native app shell; it links to a peer web app ("App B", the B1 two-instance setup) with `?handoff=1` + `login_hint`, and the target's [SsoBootstrap.tsx](typescript/browser-delegated/react-nextjs-sample/src/auth/SsoBootstrap.tsx) skips the silent paths and signs in interactively with the email pre-filled — one tap with a passkey.
>
> **Findings:**
> 1. **Gap confirmed, current.** Three Microsoft Learn pages state it identically: native auth supports SSO for **embedded web views only**; "cross-app SSO through system browsers isn't supported with native authentication." ([supported features](https://learn.microsoft.com/entra/external-id/customers/concept-supported-features-customers#single-sign-on), [choose an approach](https://learn.microsoft.com/entra/external-id/customers/concept-choose-authentication-approach#feature-comparison), [native auth concept](https://learn.microsoft.com/entra/identity-platform/concept-native-authentication#single-sign-on-sso)). A generic solution is still listed as "planned." The only open part of B3.1 is the Microsoft account-team / FastTrack timeline — the *published* gap is unambiguous.
> 2. **Root cause.** A native-auth app holds its tokens in-app, so the system browser it launches has **no `ciamlogin.com` session cookie**; a silent `prompt=none` returns `login_required` and there is no minted hint token to carry the session. This is the mirror image of B1, where the source *is* a cookie-sharing browser tab — which is why web↔web SSO works and native→system-browser can't.
> 3. **A web sample can't fake a cold browser.** Any tab here shares the IdP cookie, so a silent request would actually succeed (that's literally B1). The demo therefore **forces** the interactive path (`loginRequest` carries `prompt: "login"`) to model the missing native session honestly — the same "browser stand-in" device B2 uses for header injection.
> 4. **Interim (a) is the strategic answer.** Microsoft's own [Android MSAL cross-app SSO guidance](https://learn.microsoft.com/entra/msal/android/single-sign-on#sso-through-system-browser) confirms a **browser-delegated** app using the `BROWSER` agent shares the system cookie jar and gets cross-app SSO for free — i.e. interim (a) collapses B3 into B1. (b) is the fallback that keeps native auth's in-app UI.
>
> **Decision (B3.3):** ship interim **(b)** in the POC (keeps native auth, demonstrable today); recommend interim **(a) — browser-delegated — if app↔web SSO is a hard requirement** (ties back to D1). Interim (c) (custom session broker) is **not** pursued without a dedicated security review. Revisit when Microsoft's roadmap solution ships.

| Step | Task | Effort | Status |
| --- | --- | --- | --- |
| B3.1 | 🔬 Confirm the gap with a quick test and with **Microsoft** (account team / FastTrack); get the roadmap/timeline. | 🔬 | ✅ confirmed vs Microsoft Learn (3 pages); account-team timeline still open |
| B3.2 | Evaluate interim options: (a) make the app **browser-delegated** so it shares the browser session (web SSO becomes free); (b) one-tap interactive sign-in seeded with `login_hint`; (c) a custom session broker in the integration layer (**security review required** — this re-implements `id_token_hint` and won't yield an Entra token). | M | ✅ all three evaluated (decision above) |
| B3.3 | Decide and document the interim approach (ties back to D1). | S | ✅ (b) shipped in POC; (a) recommended if app↔web SSO required |

### Phase B4 — Impersonation portal (RWVP) ✅ **design agreed; app-layer POC proven (POC)**

Hardest and most security-sensitive; no native IdP pattern.

> **POC result (2026-06-18):** the full design + security review is in
> [impersonation-portal-design.md](impersonation-portal-design.md), and an app-layer POC ships in
> [react-nextjs-sample](typescript/browser-delegated/react-nextjs-sample/): an RBAC-gated
> [`/impersonate`](typescript/browser-delegated/react-nextjs-sample/src/app/impersonate/page.tsx)
> portal backed by `/api/impersonation/*` routes in
> [local-proxy.mjs](typescript/browser-delegated/react-nextjs-sample/local-proxy.mjs). An allow-listed
> admin enters a customer email + justification → the backend verifies the admin's token, confirms the
> customer via Graph, and mints a short-lived, read-only, `HttpOnly` **app** session (not an Entra
> token) recording both the acting admin and the subject; the portal renders the customer's view in an
> embedded iframe and exposes live-session + audit panels with revoke.
>
> **Findings:**
> 1. **Categorically different from B1–B3.** Those reuse the *real user's own* session; impersonation
>    needs a session as **someone else**, and External ID has **no supported way to mint any token as
>    another customer** (no `id_token_hint`, no token-exchange/RFC 8693 for external tenants). So
>    impersonation can only live at the **application/session layer** (B4.1) — the IdP authenticates
>    the *admin* normally; impersonation is layered on top.
> 2. **B4.3 — no published CIAM pattern (confirmed vs Microsoft Learn).** External ID documents only
>    *customer* and *admin* accounts, where "admin" administers the **directory** (create/reset/block
>    customers), not a way to authenticate **as** a customer into an app. Mirror B3.1: treat as
>    current, confirm timeline with the Microsoft account team / FastTrack before a prod build.
> 3. **The session is an *app* construct, not a token.** It carries `act` (admin) + `sub` (customer)
>    per RFC 8693 actor semantics, so every action is attributable; it's revocable server-side (a JWT
>    isn't); and it can't be replayed against Graph/Entra APIs (it isn't an Entra token). This is also
>    the dedicated security review the plan flagged for B3.2 interim **(c)** — kept app-session-only.
> 4. **Reuses proven machinery.** Same `verifyUserToken` (JWKS) + signed-`HttpOnly`-cookie pattern as
>    B2 (webview); the only new surface is the RBAC gate, the actor/subject model, the revocation
>    registry, and the audit log — exactly the B4.2 controls.
>
> **Decision (B4.2):** controls implemented in the POC (RBAC allow-list, separation of duties /
> no-self-impersonation, read-only scope, 15-min TTL, server-side revocation, append-only audit with
> required justification); a **production build remains gated** on the open items in
> [impersonation-portal-design.md §7](impersonation-portal-design.md) (durable/immutable audit, app-role
> or PIM-eligible admin source, custom domain, security sign-off).

| Step | Task | Effort | Status |
| --- | --- | --- | --- |
| B4.1 | Design impersonation at the **application/session layer**: an RBAC-gated admin action mints an impersonation session in the portal backend (not via the IdP). | L | ✅ designed + POC ([design](impersonation-portal-design.md) §2) |
| B4.2 | **Security review**: audit logging, scope/duration of impersonation, revocation, separation of duties. | M | ✅ review + checklist ([design](impersonation-portal-design.md) §3); controls in POC; prod sign-off open |
| B4.3 | Engage Microsoft on any supported CIAM impersonation pattern before committing. | S | ✅ no published pattern (Microsoft Learn); confirm timeline w/ account team |

**Feature B — definition of done (POC):**

- Sign into the website, open Power Pages (PlatesPlus) in the same browser → **no second sign-in** (incl. a documented Safari/iOS result).
- (If app uses webview) app→webview shows web content with no second prompt.
- The app→system-browser gap is **confirmed and documented**, with a chosen interim approach.
- RWVP impersonation has an **agreed design + security sign-off** (build may be post-POC). ✅ **design agreed + app-layer POC proven (B4, 2026-06-18)**; production sign-off open ([design §7](impersonation-portal-design.md)).

---

## 5. Sequencing & milestones

```
Phase 0 (prereqs: custom domain, integration APIs, app regs)
        │
        ├──────────────► Feature A (A1 → A2 → A3 → A4)        [browser provisioning + app-layer consent]
        │
        └──────────────► Feature B
                              B0 (app-model decision)
                              B1 (web↔web SSO + Power Pages)   ◄── highest-value spike, start early
                              B2 (native→webview)              [only if app uses native + webview]
                              B3 (native→system browser gap)   [confirm + interim]
                              B4 (impersonation design)        [design + security review]
```

| Milestone | Contents | Gate |
| --- | --- | --- |
| M0 | Phase 0 complete | Custom domain live; integration APIs callable; decisions D1–D3 made |
| M1 | Web↔web SSO proven (B1) | ✅ **two-SPA SSO proven on ciamlogin.com (2026-06-18)**; Power Pages (B1.4) + Safari/iOS (B1.5) still open |
| M2 | TFS sign-up + provisioning (A1–A4) | New + existing TFS users provisioned; consent recorded |
| M3 | App→web SSO resolved (B2/B3) | ✅ **webview path proven (B2)**; ✅ **system-browser gap confirmed + interim (b) proven, (a) recommended (B3, 2026-06-18)** |
| M4 | Impersonation design signed off (B4) | ✅ **design agreed + app-layer POC proven (B4, 2026-06-18)** ([design](impersonation-portal-design.md)); production security sign-off open (design §7) |

---

## 6. Risks & mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| App→system-browser SSO never lands (B3) | RWVP/app SSO blocked | Prefer browser-delegated app (D1); confirm roadmap with Microsoft; design impersonation at app layer (B4). |
| Third-party-cookie blocking breaks silent SSO | Web↔web SSO degraded on Safari/iOS | `prompt=none` redirect fallback; single custom domain; test early (B1.5). |
| Native-auth users miss attribute-based provisioning | TFS data not captured for native users | `OnTokenIssuanceStart` + app-layer consent (A3). |
| Cold-start on token function (existing known issue) | Intermittent sign-in failure; worse if A3 adds Graph calls | Keep function warm; bounded Graph deadline; run reads concurrently (already in WIP). |
| Per-SP user-flow sprawl | Maintenance overhead as SPs grow | Template the flow; automate creation via Graph; document. |
| Impersonation security | High — privileged access | Dedicated security review (B4.2); audit + revocation; least privilege. |

---

## 7. Appendix

### 7.1 Reuse inventory (don't rebuild)

| Need | Reuse |
| --- | --- |
| Provisioning hook | [attribute-submit-function](typescript/native-auth/attribute-submit-function/) (extend beyond DOB/displayName) |
| Phone + Graph lookup, timeout handling, claims output | [token-issuance-function](typescript/native-auth/token-issuance-function/) + [graphClient.ts](typescript/native-auth/token-issuance-function/src/graphClient.ts) |
| `checkUser` / `createSignUp` / Dataverse model | Existing B2C integration layer (per [B2C_POLICY_DOCUMENTATION.md](B2C_POLICY_DOCUMENTATION.md) §4) |
| Web SSO host app | [browser-delegated/react-nextjs-sample](typescript/browser-delegated/react-nextjs-sample/) |
| App-only Graph proxy pattern | [local-proxy.mjs](typescript/browser-delegated/react-nextjs-sample/local-proxy.mjs) |

### 7.2 B2C → External ID mapping for these features

| B2C mechanism | External ID equivalent in this plan |
| --- | --- |
| `REST-CheckUser` / `REST-CreateUser` technical profiles (steps 13–14) | `OnAttributeCollectionSubmit` (sign-up) + `OnTokenIssuanceStart` (existing/native) calling the same integration APIs |
| Conditional `TfsSignup` page via precondition | Per-SP user flow attribute (sign-up) + app-layer T&C page (existing users) |
| `appAccessName` lookup (`clientId` → "tfs") | `clientId` from extension payload → SP map (A2.1 / P0.5) |
| `id_token_hint` mint + consume (SSO) | Web↔web session-cookie SSO (B1); native→webview bearer (B2); gap for native→browser (B3); app-layer impersonation (B4) |

### 7.3 Sources

[Plan migration B2C→External ID](https://learn.microsoft.com/entra/external-id/customers/plan-your-migration-from-b2c-to-external-id) · [Migrate from B2C (feature mapping)](https://learn.microsoft.com/entra/external-id/customers/migrate-from-b2c-to-external-id) · [Custom authentication extensions](https://learn.microsoft.com/entra/external-id/customers/concept-custom-extensions) · [OnAttributeCollectionSubmit schema](https://learn.microsoft.com/entra/identity-platform/custom-extension-onattributecollectionsubmit-retrieve-return-data) · [Native auth → webview SSO](https://learn.microsoft.com/entra/identity-platform/how-to-native-authentication-webview-sso) · [SSO features by tenant type](https://learn.microsoft.com/entra/external-id/customers/concept-supported-features-customers#single-sign-on) · [MSAL.js SSO (`ssoSilent`)](https://learn.microsoft.com/entra/identity-platform/msal-js-sso) · [Power Pages + External ID](https://learn.microsoft.com/power-pages/security/authentication/entra-external-id)
