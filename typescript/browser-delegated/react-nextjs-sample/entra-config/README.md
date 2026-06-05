# Entra External ID configuration — browser-delegated Service Tasmania POC

This is the **portal + Microsoft Graph** setup that backs the browser-delegated app
in `../`. None of it lives in app code — it's tenant configuration. Work top to
bottom; each step notes the B2C feature it replaces.

- **Tenant**: `myservicetasdevpoc` (`a67366e7-9873-4a38-9bae-0a4a18952688`)
- **Login host**: `myservicetasdevpoc.ciamlogin.com`

> The four extension Functions referenced below already exist under
> `../../../native-auth/` (`otp-email-function`, `attribute-start-function`,
> `attribute-submit-function`, `token-issuance-function`). They are reused as-is;
> browser user flows fire `OnAttributeCollectionStart/Submit`, which native auth did
> not, so they now map directly onto the B2C REST steps.

---

## 1. Custom user attributes  (B2C: signup form attrs)

Entra ID → External Identities → **Custom user attributes** → create:

| Attribute | Data type | Replaces |
|---|---|---|
| `dateOfBirth` | String | B2C `extension_dateOfBirth` |
| `termsAndConditions` | Boolean | B2C `extension_termsAndConditions` |
| `termsAndConditionsTfs` | Boolean | B2C `termsAndConditionstfs` |

These are created against the `b2c-extensions-app`; their real ids are
`extension_<extAppId-no-hyphens>_<name>`. Record them — they appear in the
extension payloads and must be added to the token-issuance claims mapping if you
want them in the token.

## 2. Sign-up & sign-in user flow  (B2C: SignUpOrSignIn_Custom journey)

Entra ID → External Identities → **User flows** → New user flow `ServiceTas_SignUpSignIn`:

- **Identity providers**: *Email with password* (this exposes the SSPR
  **Forgot password?** link → the password-reset flow, replacing B2C
  `B2C_1A_PasswordReset`).
- **MFA**: enable **SMS** and **Email one-time passcode** as second factors
  (see step 4).
- **User attributes** to collect: Given Name, Surname (required), Display Name,
  `dateOfBirth`, `termsAndConditions`, and `termsAndConditionsTfs`.
- After creation: **Applications** → add the SPA app from step 5.

> **App ↔ flow rule**: an app maps to exactly one user flow, but a flow serves many
> apps. This POC uses **one** flow for both TFS and MST and branches on `client_id`
> inside the extensions. Split into a second flow later only if the two apps need
> different attribute pages.

## 3. Register the custom authentication extensions  (B2C: REST + OnOtpSend)

For each Function, register a custom authentication extension under
External Identities → **Custom authentication extensions**, create/reuse the
"Azure Functions authentication events API" app registration, and **Grant
permission** (admin consent for `Receive custom authentication extension HTTP
requests`). Then attach them to the user flow.

| Function | Event | Attach at | B2C equivalent |
|---|---|---|---|
| `otp-email-function` | OnOtpSend | (tenant-level email OTP) | branded OTP email |
| `attribute-start-function` | OnAttributeCollectionStart | flow → *Before collecting information* | `REST-CheckValidEmail` (block) |
| `attribute-submit-function` | OnAttributeCollectionSubmit | flow → *When a user submits their information* | `REST-CheckValidEmail` + `REST-CheckUser` + `REST-CreateUser` + attr validation |
| `token-issuance-function` | OnTokenIssuanceStart | custom claims provider on the SPA app | `phone_number` claim from Graph |

App settings to set on the Function Apps:
- All blocklist functions: `BLOCKED_EMAILS`, `BLOCKED_DOMAINS` (keep in sync).
- `attribute-submit-function`: **`TFS_CLIENT_ID`** = the TFS app's client id (the
  app whose sign-ups should trigger TFS provisioning). Non-matching apps skip it.
- `token-issuance-function`: `GRAPH_*` creds + `PHONE_CLAIM_ID` (default `phoneNumber`).

## 4. MFA + Conditional Access  (B2C: PhoneFactor + CA + MFA whitelist)

- **SMS add-on**: SMS MFA requires the external tenant **linked to a paid Azure
  subscription**. Entra ID → External Identities → pricing/linked subscription.
  Check AU **opt-in regions** for SMS (`how-to-region-code-opt-in`).
- **Authentication methods**: enable **SMS** and **Email OTP**; target All users.
- **CA — Require MFA**: new policy targeting the POC app(s) + all users → Grant:
  *Require multifactor authentication*. (= B2C Step 8/11.)
- **CA — MFA exclusion** (replaces the hardcoded `doolse@gmail.com` bypass): create
  a security group, add the exempt user(s), and **exclude** that group from the
  Require-MFA policy. This is the documented, auditable replacement for the B2C
  whitelist.
- **CA — Block** (optional, demonstrates B2C Step 10 block page): a policy with
  Grant: *Block access* targeting a test condition.

> Gap: External ID CA has no `chg_pwd` grant control (B2C's `CAChallengeIsChgPwd`
> was never wired up either). Risk-based signals depend on tenant licensing.

## 5. App registration (SPA)  (B2C: relying-party application)

Entra ID → App registrations → New registration `ServiceTas Browser POC`:

- Platform **Single-page application**.
- Redirect URIs: `http://localhost:3000/` (dev) **and** the deployed SWA origin
  `https://<your-swa>.azurestaticapps.net/` (prod). The app uses the app root as
  its redirect URI (see `src/config/auth-config.ts`).
- Copy the **Application (client) ID** into `clientId` in
  `../src/config/auth-config.ts` (replace `REPLACE_WITH_BROWSER_POC_SPA_CLIENT_ID`).
- Associate this app with the `ServiceTas_SignUpSignIn` user flow (step 2).

### Claims-mapping policy (for the `phone_number` claim)

Create the claims-mapping policy from
`../../../native-auth/token-issuance-function/claims-mapping-policy.json` via Graph
and assign it to **this SPA app's service principal**, and attach the
`token-issuance-function` as the custom claims provider, so the MFA phone number is
emitted as `phone_number`. (Same procedure as the native-auth POC — see that
function's README.)

## 6. Deployment

- The SPA is a static export → deploy to **Azure Static Web Apps** (sibling to the
  native-auth SWA). No managed API function is needed — browser-delegated redirects
  go straight to `ciamlogin.com`, so there is **no CORS proxy** here.
- Add the production SWA origin as a redirect URI (step 5) before testing prod.
- The Functions deploy via their existing `deploy/` PowerShell scripts; just point
  their extension registrations at this flow.

---

## Branding

Upload `custom-ui.css` under Entra ID → **Company branding** → Sign-in form →
Custom CSS, and set the Service Tasmania logos/background there. Branding is
**tenant-wide** (per-app branding is not yet GA), so all user flows in this tenant
share the look.

## Documented fidelity gaps (vs B2C)

1. **`id_token_hint` cross-app SSO** — not supported by user flows. Normal SSO uses
   the MSAL session cookie + `ssoSilent`/`login_hint`. The mobile-app "mint JWT →
   skip login" model is out of scope.
2. **Conditional TFS T&Cs** — a user flow can't skip the T&Cs page based on a
   `checkUser` result mid-flow. The TFS T&Cs box always shows for the TFS app;
   `createSignUp` is idempotent so returning users are harmless.
3. **Password policy** — Entra's fixed policy (8–256, 3-of-4) applies; the B2C
   8–20 + exact regex can't be enforced.
4. **Page customisation** — company branding + custom CSS only (no custom HTML/JS).
5. **Telemetry** — no per-step App Insights TrackEvent; use Entra sign-in logs +
   Function App Insights.
