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
| D1 | **Mobile app auth model** | Native auth (full in-app UI) **vs** browser-delegated (redirect) | Drives Feature B. Browser-delegated gives **web SSO for free** (shared `ciamlogin.com` session); native blocks app→system-browser SSO (B3). If app↔web SSO is a hard requirement, lean browser-delegated. |
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

- New TFS user (browser): completes sign-up, sees TFS T&C, lands provisioned in Dataverse (Contact + consent + service-link); verified by `checkUser` returning "has consent".
- Existing myServiceTas user opening the TFS app first time: prompted for TFS T&C **by the app**, consent recorded, service linked.
- Non-TFS app: no TFS T&C shown; no TFS provisioning.
- Blocked email still blocked (existing OnOtpSend/OnAttributeCollectionStart behaviour intact).
- Re-running sign-up is idempotent (no duplicate Dataverse rows).

---

## 4. Feature B — Cross-app SSO (replacing B2C `id_token_hint`)

**`id_token_hint` is not available in External ID.** Decompose by scenario; each has a different answer.

### Phase B0 — Confirm the app auth model (Decision D1)

| Step | Task | Effort |
| --- | --- | --- |
| B0.1 | Confirm native vs browser-delegated for the mobile app, because it determines whether B3 (app→system-browser SSO) is a free win or a platform gap. | S |

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

### Phase B3 — Native app → system browser / separate web app (the genuine gap)

This is the literal B2C `id_token_hint` flow. **Not currently supported** ("cross-app SSO through system browsers isn't supported with native authentication"; a generic solution is "planned for a future release").

| Step | Task | Effort |
| --- | --- | --- |
| B3.1 | 🔬 Confirm the gap with a quick test and with **Microsoft** (account team / FastTrack); get the roadmap/timeline. | 🔬 |
| B3.2 | Evaluate interim options: (a) make the app **browser-delegated** so it shares the browser session (web SSO becomes free); (b) one-tap interactive sign-in seeded with `login_hint`; (c) a custom session broker in the integration layer (**security review required** — this re-implements `id_token_hint` and won't yield an Entra token). | M |
| B3.3 | Decide and document the interim approach (ties back to D1). | S |

### Phase B4 — Impersonation portal (RWVP)

Hardest and most security-sensitive; no native IdP pattern.

| Step | Task | Effort |
| --- | --- | --- |
| B4.1 | Design impersonation at the **application/session layer**: an RBAC-gated admin action mints an impersonation session in the portal backend (not via the IdP). | L |
| B4.2 | **Security review**: audit logging, scope/duration of impersonation, revocation, separation of duties. | M |
| B4.3 | Engage Microsoft on any supported CIAM impersonation pattern before committing. | S |

**Feature B — definition of done (POC):**

- Sign into the website, open Power Pages (PlatesPlus) in the same browser → **no second sign-in** (incl. a documented Safari/iOS result).
- (If app uses webview) app→webview shows web content with no second prompt.
- The app→system-browser gap is **confirmed and documented**, with a chosen interim approach.
- RWVP impersonation has an **agreed design + security sign-off** (build may be post-POC).

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
| M3 | App→web SSO resolved (B2/B3) | ✅ **webview path proven (B2, 2026-06-18)**; system-browser gap (B3) still to confirm/decide |
| M4 | Impersonation design signed off (B4) | Security review passed |

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
