# Impersonation Portal (RWVP) — Design & Security Review

**Phase B4** of [plan_thirdparty_signup_and_sso.md](plan_thirdparty_signup_and_sso.md), Feature B
(cross-app SSO / the `id_token_hint` replacements). This is the design artifact and security
review the plan's B4 definition-of-done calls for ("RWVP impersonation has an agreed design +
security sign-off; build may be post-POC"), plus the findings from the POC that ships alongside it
in [react-nextjs-sample](typescript/browser-delegated/react-nextjs-sample/).

> **Status:** design agreed for POC; security review checklist below; build is a labelled POC
> (app-layer only). A production build remains gated on the open items in §7.

---

## 1. The problem and why it's different from B1–B3

In B2C the RWVP impersonation portal worked the same way every other cross-app SSO scenario did:
mint an `id_token_hint` for the target user and hand it to the relying app, which consumed it and
signed the user in. The portal was "just another consumer" of the hint-token mechanism.

**External ID has no `id_token_hint`, and — distinct from B1/B2/B3 — there is no supported way to
obtain *any* token as another customer.** B1 (web↔web) and B2 (native→webview) work because the
real signed-in user's *own* session is reused. B3's gap is about *transport* (a cold system browser)
but still concerns the user's own session. Impersonation is categorically different: the acting
party is an **administrator**, and the identity to be presented is **someone else's**. No Entra flow
issues that token for a CIAM customer.

**B4.3 — engagement / platform check (confirmed against Microsoft Learn, 2026-06-18):** External ID
for customers documents only two account types — *customer accounts* and *admin accounts* — where
"admin account" means a work account that administers the **directory** (create/reset/block customer
accounts), *not* a way to authenticate **as** a customer into a relying application. There is no
published CIAM impersonation / "sign in as user" / delegated-session feature, and no token-exchange
(RFC 8693) endpoint for external tenants. Recommendation mirrors B3.1: treat the absence as current
and **confirm with the Microsoft account team / FastTrack** before committing a production build;
revisit if a supported pattern ships.

**Conclusion (B4.1):** impersonation must be built at the **application / session layer**, owned by
the portal backend — never by the IdP. The IdP authenticates the *administrator* normally; the
*impersonation* is an application construct layered on top.

---

## 2. Design (B4.1)

### 2.1 Model

An impersonation **session** is a signed, short-lived, `HttpOnly` **application** cookie minted by
the portal backend. It is **not** an Entra token and carries no Graph/Entra authority. It records
**both** identities, mirroring RFC 8693 token-exchange *actor* semantics:

| Field | Meaning |
| --- | --- |
| `sessionId` | Opaque id; the key for revocation and the audit trail |
| `act` (actor) | The **acting administrator** — who is really driving |
| `sub` (subject) | The **impersonated customer** — whose view is shown |
| `reason` | Mandatory justification, captured for audit |
| `scope` | `read-only` for the POC |
| `iat` / `exp` | Issued-at / hard expiry (bounded duration) |
| `impersonated: true` | Explicit marker so downstream code never confuses it with a real session |

Because `act` is always present and distinct from `sub`, **every action taken under an impersonation
session is attributable to the administrator acting-as the customer** — the property an auditor and
a "separation of duties" control both require.

### 2.2 Flow

```
Admin (signed in normally, MSAL)         Portal backend (local-proxy.mjs / prod: Function)
  POST /api/impersonation/start
    Authorization: Bearer <admin ID token>
    { subjectEmail, reason } ───────────▶ 1. verify admin token (JWKS: sig/iss/aud/tid/exp)
                                          2. RBAC gate: admin on allow-list? else 403 not_admin
                                          3. require reason; reject self-impersonation (SoD)
                                          4. resolve subject via Graph (confirm exists; capture oid/name)
                                          5. mint session → registry + audit("start")
                                          ◀─ Set-Cookie: st_impersonation_session=… HttpOnly
  <iframe src="/impersonate-view"> ─────▶ cookie-gated customer view (banner: who/as-whom/expiry)
  POST /api/impersonation/stop  ────────▶ delete from registry + clear cookie + audit("stop")
  POST /api/impersonation/revoke {id} ──▶ (admin) delete from registry + audit("revoke")
  GET  /api/impersonation/audit ────────▶ (admin) live sessions + append-only log
```

The view pages (`/impersonate-view`) are gated on the **cookie alone** — no token is ever minted as
the subject. The "customer view" is the relying app rendering the subject's data because the portal
session authorises a read on the subject's behalf; the app reads `sub` for *what* to show and `act`
for *who is allowed to* and *what to log*.

### 2.3 Why a cookie / app session (not a token)

- There is no issuer that will mint an Entra token for `sub` on an admin's behalf (see §1).
- An app session keeps the blast radius inside the portal/relying app: it cannot be replayed against
  Microsoft Graph or any Entra-protected API, because it isn't an Entra token.
- It is revocable server-side (a JWT/access token is not, until expiry) — see §3 revocation.

---

## 3. Security review (B4.2)

| Control | Requirement | How the POC meets it | Production hardening |
| --- | --- | --- | --- |
| **RBAC** | Only authorised admins may impersonate | `isImpersonationAdmin()` allow-list (`IMPERSONATION_ADMIN_EMAILS`/`_OIDS`); 403 `not_admin` otherwise; admin's ID token verified against tenant JWKS first | Source from an **app role** (`roles` claim) or a **PIM-eligible** security group; require the role be *activated* (just-in-time), not standing |
| **Separation of duties** | An admin can't grant themselves rights via impersonation | Self-impersonation rejected (by email and by resolved `oid`); the session is **not** an Entra token and never elevates the admin's own account; `act`≠`sub` always recorded | Block impersonating *other admins*; consider two-person approval for sensitive subjects |
| **Least privilege** | Impersonation should not be a write-anything backdoor | `scope: "read-only"`; the impersonated view is read-only; downstream writes gate on absence of `act` | Per-action scopes; explicit deny-list of high-risk operations even read-only |
| **Bounded duration** | Sessions must not linger | 15-minute hard `exp` baked into the cookie + registry | Configurable, short; idle timeout in addition to absolute |
| **Revocation** | A live session must be killable immediately | Server-side **active-session registry**; `stop` and `revoke` delete from it; `readImpersonationSession` rejects any cookie whose `sessionId` isn't live; process restart drops all (fail-closed) | Durable store (Redis/table); a "kill all" switch; revoke on admin deprovision |
| **Audit logging** | Who impersonated whom, when, why | Append-only `impersonationAudit` (start/stop/revoke with actor, subject, reason, time); `console.log` per event; readable by admins via `/audit` | Ship to **Azure Monitor / SIEM**, immutable + tamper-evident; alert on anomalies (volume, off-hours, sensitive subjects) |
| **Justification** | Every session needs a recorded reason | `reason` required (≥5 chars), stored in cookie + audit | Tie to a ticket id; validate against the ticketing system |
| **Token confidentiality** | No secrets / impersonation authority in the browser | Cookie is `HttpOnly` + HMAC-signed with a server-only per-process key; the SPA never sees signing material | Key in Key Vault / managed identity; rotate |
| **Subject confirmation** | Can't impersonate a non-existent / ambiguous account | Graph lookup by sign-in identity then `mail`; 404 if none, 409 if >1 | Same; log failed lookups (recon signal) |
| **Transport / cookie scope** | Session cookie must not leak cross-site | `SameSite=Lax`, same-site (localhost) in dev; one custom URL domain in prod | `Secure`; consider host-only; CHIPS if genuinely cross-site |

### 3.1 Explicit non-goals / residual risks

- **Not a real token.** A relying app that needs to call an Entra-protected API *as the customer*
  still can't — there's no token. The portal can only show data the **app/backend** can read with
  its own authority, filtered to the subject. This is a deliberate boundary, not a bug.
- **In-memory state (POC only).** Registry + audit live in process memory; a restart is fail-closed
  for sessions but **loses the audit history**. Production must persist both (audit durably/immutably).
- **`ALLOW_ANY_ADMIN` dev flag.** Convenience for local demos; must never be set in production. The
  portal surfaces it loudly.
- **Interim option (c) overlap.** This is the "custom session broker" the plan flagged under B3.2(c)
  as needing a dedicated security review. That review is *this document*; it remains app-session-only
  and deliberately does **not** attempt to re-mint an Entra token.

---

## 4. POC scope (what shipped)

In [react-nextjs-sample](typescript/browser-delegated/react-nextjs-sample/):

- `local-proxy.mjs` — `/api/impersonation/{start,stop,revoke,whoami,audit}` + cookie-gated
  `/impersonate-view[/profile]`, with the controls in §3.
- `src/app/impersonate/page.tsx` — the portal: start form (email + justification), the embedded
  read-only customer view, live-session + audit-log panels with revoke, and an explicit
  RBAC-denied state.
- `src/services/impersonation-service.ts`, `src/config/auth-config.ts`, `src/components/Navbar.tsx`.

It reuses the **exact** token-verification machinery (`verifyUserToken`) and the signed-`HttpOnly`-cookie
pattern proven in B2 (webview), so the only genuinely new surface is the RBAC gate, the actor/subject
session model, the revocation registry, and the audit log.

---

## 5. Production architecture (when/if built)

- Move the endpoints into a real backend (the SWA's managed Functions), secret/signing key in Key
  Vault or a managed identity.
- Admin rights from an **app role** or **PIM-eligible** group, JIT-activated.
- Durable, immutable audit (Azure Monitor / Log Analytics) with alerting.
- Durable revocation store; revoke on admin offboarding.
- One **custom URL domain** so cookies stay first-party across the portal and relying apps.
- Per-action scopes and a high-risk-operation deny-list.

---

## 6. Mapping to the plan

| Plan step | Status |
| --- | --- |
| **B4.1** Design impersonation at the app/session layer (RBAC-gated, not via the IdP) | ✅ §2; POC shipped |
| **B4.2** Security review: audit, scope/duration, revocation, separation of duties | ✅ §3 (review + checklist); controls implemented in the POC |
| **B4.3** Engage Microsoft on any supported CIAM impersonation pattern | ✅ no published pattern (Microsoft Learn, §1); confirm timeline with account team before a prod build |

---

## 7. Open items before a production commit

1. Microsoft account-team confirmation that no supported CIAM impersonation pattern is imminent (B4.3).
2. Admin-rights source decision: app role vs PIM-eligible group (+ JIT activation).
3. Durable + immutable audit and revocation stores; SIEM integration + alerting.
4. Per-action scope model and high-risk-operation deny-list.
5. Custom URL domain (shared with P0.1) for first-party cookies across portal + relying apps.
6. Formal sign-off from security on this document.
