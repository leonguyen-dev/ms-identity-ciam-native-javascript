import {
    Configuration,
    LogLevel,
    RedirectRequest,
    EndSessionRequest,
} from "@azure/msal-browser";
import { CustomAuthConfiguration } from "@azure/msal-browser/custom-auth";

/**
 * Browser-delegated (redirect) configuration for the Service Tasmania POC on
 * Microsoft Entra External ID.
 *
 * Unlike the native-auth sample (which renders every form in React and proxies
 * the native-auth REST API), this app hands the sign-in / reset experience to
 * the Entra-hosted user-flow pages. MSAL only kicks off the redirect and reads
 * the resulting tokens. The ONE exception is sign-up: /sign-up renders the
 * native-auth sign-up flow in React (see customAuthConfig below), then hands
 * the brand-new account off to a hosted sign-in redirect — so the local proxy
 * doubles as the native-auth CORS proxy for that flow.
 *
 * Authority note: for External ID you do NOT put the user-flow name in the
 * authority (that was a B2C custom-policy convention). The authority is just the
 * tenant; the app is bound to its user flow in the Entra admin centre
 * (External Identities > User flows > <flow> > Applications).
 */

const TENANT_SUBDOMAIN = "myservicetasdevpoc";
const TENANT_ID = "a67366e7-9873-4a38-9bae-0a4a18952688";

/**
 * The SPA client id. Defaults to the original browser-delegated POC app so App A
 * runs unchanged, but can be overridden at build/dev time with
 * NEXT_PUBLIC_CLIENT_ID. This is what lets the *same* codebase run as a second,
 * distinct relying party ("App B") for the cross-app SSO spike (Feature B / B1):
 * a different client id means a different app registration and a different
 * sessionStorage cache, so a silent sign-in there proves true cross-app SSO
 * rather than a shared MSAL cache.
 */
const CLIENT_ID =
    process.env.NEXT_PUBLIC_CLIENT_ID ?? "5f0a52ca-f5db-4a6d-9b3a-3180d51fdd08";

/**
 * Human label for this instance (shown in the UI so you can tell App A from App
 * B during the SSO demo). Cosmetic only.
 */
export const appLabel = process.env.NEXT_PUBLIC_APP_LABEL ?? "myServiceTas";

/**
 * The peer web app to offer a one-click "open in SSO" link to, if configured
 * (e.g. App A points at App B's origin). Used only by the cross-app SSO demo
 * link on the signed-in view; unset in normal single-app use.
 */
export const peerAppUrl = process.env.NEXT_PUBLIC_PEER_APP_URL;
export const peerAppLabel = process.env.NEXT_PUBLIC_PEER_APP_LABEL ?? "Relying app";

/**
 * Resolve the redirect/post-logout URI at runtime so one build works in both
 * local dev and the deployed SWA. Both values must be registered as SPA
 * redirect URIs on the app registration (see entra-config/README.md).
 */
function resolveAppOrigin(): string {
    if (typeof window === "undefined") {
        // Build-time prerender only — never used for a live redirect.
        return "http://localhost:3000";
    }
    return window.location.origin;
}

export const msalConfig: Configuration = {
    auth: {
        // SPA app registration created for the browser-delegated POC.
        // Defaults to the original POC app id; override with NEXT_PUBLIC_CLIENT_ID
        // to run this codebase as a second relying party (App B) for the SSO spike.
        clientId: CLIENT_ID,
        authority: `https://${TENANT_SUBDOMAIN}.ciamlogin.com/${TENANT_ID}`,
        knownAuthorities: [`${TENANT_SUBDOMAIN}.ciamlogin.com`],
        redirectUri: `${resolveAppOrigin()}/`,
        postLogoutRedirectUri: `${resolveAppOrigin()}/`,
        // Return the user to the page that started login after the redirect is
        // processed (here that is always "/", which renders the signed-in view).
        navigateToLoginRequestUrl: true,
    },
    cache: {
        // Match the native-auth sample: tokens live only for the browser tab.
        cacheLocation: "sessionStorage",
        storeAuthStateInCookie: false,
    },
    system: {
        loggerOptions: {
            // Only surface warnings and errors. MSAL logs cache reads
            // ("Returning ID token", "Returning access token") at Info on every
            // token read, which floods the console after sign-in. Bump to Verbose
            // temporarily when debugging the auth flow.
            logLevel: LogLevel.Warning,
            loggerCallback: (level: LogLevel, message: string, containsPii: boolean) => {
                if (containsPii) {
                    return;
                }
                switch (level) {
                    case LogLevel.Error:
                        console.error(message);
                        return;
                    case LogLevel.Warning:
                        console.warn(message);
                        return;
                    case LogLevel.Info:
                        console.info(message);
                        return;
                    case LogLevel.Verbose:
                        console.debug(message);
                        return;
                }
            },
        },
    },
};

/**
 * Scopes requested at sign-in. openid + profile yield the ID token; the custom
 * `phone_number` claim is injected by the OnTokenIssuanceStart extension via the
 * claims-mapping policy assigned to this app (see token-issuance-function).
 * offline_access requests a refresh token for silent renewal.
 *
 * `email` yields the `email` claim, sourced from the user's mail attribute. Use
 * it (not `preferred_username`) to display the user's email: preferred_username
 * is mutable and reflects the sign-in *credential*, so a passkey sign-in returns
 * the synthetic UPN (<GUID>@…onmicrosoft.com) while email/SMS returns the email.
 */
export const loginRequest: RedirectRequest = {
    scopes: ["openid", "profile", "email", "offline_access"],
    // Force fresh authentication instead of silently resuming an existing Entra
    // session. Without this, a stale/half-established ciamlogin.com session from a
    // prior incomplete attempt makes "Log in" loop at the /reprocess step (Entra
    // keeps trying to resume the broken session). prompt=login sidesteps the loop
    // by always re-authenticating. (Sign-up overrides this with prompt=create.)
    prompt: "login",
};

/**
 * Hosted sign-up request. Entra External ID honours `prompt=create` to take the
 * user straight to the sign-up experience of the bound user flow, mirroring the
 * B2C "Sign up now" entry point on the combined page.
 *
 * No longer the primary entry point: the app now renders sign-up itself with
 * native authentication (see /sign-up and customAuthConfig below). Kept as the
 * documented fallback to the fully-hosted sign-up experience.
 */
export const signUpRequest: RedirectRequest = {
    ...loginRequest,
    prompt: "create",
};

/* ------------------------------------------------------------------------- *
 * Cross-app SSO (Feature B / B1)
 * ------------------------------------------------------------------------- */

/**
 * Scopes-only request for SILENT token acquisition — deliberately WITHOUT
 * `prompt`. `loginRequest` carries `prompt: "login"`, which forces a fresh
 * interactive sign-in and would defeat SSO; the silent paths must never send it.
 *
 * Used two ways by the SSO bootstrap (see auth/SsoBootstrap.tsx):
 *  1. `ssoSilent({ ...silentRequest, loginHint })` — a hidden iframe to the
 *     authorize endpoint. Succeeds only if the Entra session cookie is readable
 *     in a third-party (iframe) context — which it is NOT on ciamlogin.com once
 *     third-party cookies are blocked (Safari/iOS always; Chrome increasingly).
 *  2. `{ ...silentRequest, prompt: "none" }` passed to a top-level
 *     `loginRedirect` — the fallback. A full-page navigation makes the session
 *     cookie first-party, so Entra can resolve the existing session and return a
 *     token with no UI. Only fails (login_required) if there is truly no session,
 *     at which point the app shows the normal Log in button.
 */
export const silentRequest = {
    scopes: ["openid", "profile", "email", "offline_access"],
};

export const logoutRequest: EndSessionRequest = {};

/* ------------------------------------------------------------------------- *
 * Native app → in-app web content (embedded webview) SSO (Feature B / B2)
 * ------------------------------------------------------------------------- */

/**
 * The local-proxy port and a host-aware resolver for its origin, so a SINGLE
 * build works in every local mode with no env wiring:
 *
 *  - plain `localhost` (`npm run dev` + `npm run proxy`)
 *      → http://localhost:3001
 *  - the unified HTTPS dev hosts (`npm run dev:passkey` + `npm run proxy:https`),
 *    where the app is served from `*.<tenant>.ciamlogin.com`. The proxy must be a
 *    SIBLING subdomain (`api.<tenant>.ciamlogin.com`) so it shares the app's
 *    registrable domain: that keeps the webview HttpOnly session cookie
 *    FIRST-PARTY inside the iframe (SameSite=Lax), and HTTPS↔HTTPS sidesteps the
 *    mixed-content block an http proxy would hit from an https page.
 *      → https://api.<tenant>.ciamlogin.com:3001
 *
 * A build-time `NEXT_PUBLIC_*_API_BASE` always wins (production points these at a
 * real backend). Resolved at call time, not import time, because it reads
 * `window.location`.
 */
const PROXY_PORT = 3001;

function resolveProxyOrigin(): string {
    if (typeof window === "undefined") return `http://localhost:${PROXY_PORT}`;
    const host = window.location.hostname;
    const rpId = `${TENANT_SUBDOMAIN}.ciamlogin.com`;
    if (host === rpId || host.endsWith(`.${rpId}`)) {
        return `https://api.${rpId}:${PROXY_PORT}`;
    }
    return `http://localhost:${PROXY_PORT}`;
}

/**
 * Origin of the web resource shown inside the webview (the local proxy in dev;
 * an Azure Function / web app in production via NEXT_PUBLIC_WEBVIEW_API_BASE).
 * The demo page (app/webview/page.tsx) POSTs the signed-in user's token to
 * `${webviewProxyBase()}/api/webview/session` to establish an HttpOnly session
 * cookie, then loads `${webviewProxyBase()}/webview` in the iframe. ORIGIN only
 * (no `/api` suffix): the webview content pages live at `/webview`.
 */
export function webviewProxyBase(): string {
    return process.env.NEXT_PUBLIC_WEBVIEW_API_BASE ?? resolveProxyOrigin();
}

/**
 * Whether the webview SSO demo can work where the app is running. Like the
 * account feature it needs the local proxy, so it only lights up on the dev
 * hosts (plain `localhost` or the passkey rp domain) unless an explicit
 * NEXT_PUBLIC_WEBVIEW_API_BASE is configured. Call from an effect, not render,
 * to avoid a static-export hydration mismatch.
 */
export function webviewFeatureAvailable(): boolean {
    if (process.env.NEXT_PUBLIC_WEBVIEW_API_BASE) return true;
    if (typeof window === "undefined") return false;
    const host = window.location.hostname;
    return host === "localhost" || host === passkeyRpId || host.endsWith(`.${passkeyRpId}`);
}

/**
 * Best value to pass as an Entra `login_hint` so the hosted sign-in / MFA page
 * shows the user's email instead of the synthetic userPrincipalName
 * (<GUID>@…onmicrosoft.com). Prefers the live `signin_email` custom claim, then
 * the built-in `email`; deliberately skips `preferred_username`, which is often
 * the UPN. Returns undefined when no email-shaped value is available (omit the
 * hint rather than send a GUID).
 */
export function signInHintFromClaims(claims?: Record<string, unknown>): string | undefined {
    const hint = (claims?.signin_email as string | undefined) ?? (claims?.email as string | undefined);
    return hint && hint.includes("@") ? hint : undefined;
}

/* ------------------------------------------------------------------------- *
 * Impersonation portal — RWVP (Feature B / B4)
 * ------------------------------------------------------------------------- */

/**
 * Base URL of the impersonation portal backend (local-proxy.mjs locally; an Azure
 * Function in production via NEXT_PUBLIC_IMPERSONATION_API_BASE). External ID has
 * no supported way to mint a token AS another customer, so impersonation lives at
 * the app/session layer: an RBAC-gated admin action mints a signed HttpOnly *app*
 * session (not an Entra token) marked with both the acting admin and the subject.
 * The backend enforces the admin allow-list, the read-only scope, the bounded TTL,
 * revocation, and the audit log (plan B4.1/B4.2). Includes the `/api` suffix.
 */
export function impersonationApiBase(): string {
    return process.env.NEXT_PUBLIC_IMPERSONATION_API_BASE ?? `${resolveProxyOrigin()}/api`;
}

/**
 * Origin of the impersonated-view content pages (`/impersonate-view`), shown in the
 * portal's embedded iframe. Proxy ORIGIN (no `/api`) because those pages live at
 * `/impersonate-view`, not under `/api`.
 */
export function impersonationViewBase(): string {
    return process.env.NEXT_PUBLIC_IMPERSONATION_VIEW_BASE ?? resolveProxyOrigin();
}

/**
 * Whether the impersonation portal can work where the app is running. Like the
 * account/webview features it needs the local proxy, so it only lights up on the
 * dev hosts unless an explicit NEXT_PUBLIC_IMPERSONATION_API_BASE is set. The
 * RBAC gate is enforced server-side regardless — a signed-in non-admin sees the
 * link but gets a 403 (and the portal explains the gate). Call from an effect.
 */
export function impersonationFeatureAvailable(): boolean {
    if (process.env.NEXT_PUBLIC_IMPERSONATION_API_BASE) return true;
    if (typeof window === "undefined") return false;
    const host = window.location.hostname;
    return host === "localhost" || host === passkeyRpId || host.endsWith(`.${passkeyRpId}`);
}

/* ------------------------------------------------------------------------- *
 * Passkeys (FIDO2)
 * ------------------------------------------------------------------------- */

/**
 * Base URL of the local proxy's passkey routes (local-proxy.mjs). The Microsoft Graph
 * fido2Methods provisioning APIs need an app-only token (there is no delegated
 * self-service permission for external-tenant customers yet), so the proxy holds
 * the client secret + Graph token server-side and the SPA never sees them.
 */
export function passkeyApiBase(): string {
    return process.env.NEXT_PUBLIC_PASSKEY_API_BASE ?? `${resolveProxyOrigin()}/api`;
}

/**
 * The relying-party id passkeys are registered against (creationOptions.rp.id).
 * WebAuthn only allows registration from this domain or a subdomain of it, which
 * is why local passkey registration is served at
 * https://auth.myservicetasdevpoc.ciamlogin.com:3000 (see README "Passkeys").
 * Sign-in with a passkey is unaffected — it happens on the Entra-hosted pages,
 * which already live on this domain.
 */
export const passkeyRpId = `${TENANT_SUBDOMAIN}.ciamlogin.com`;

/**
 * Claims challenge demanding fresh MFA ("ngcmfa" = next-gen-credential MFA).
 * Passkey add/delete token requests carry this so Entra only issues the token if
 * the user completed MFA recently (otherwise the request fails with
 * Account self-management (change password / sign-in name / phone)
 * ------------------------------------------------------------------------- */

/**
 * Base URL of the account proxy (local-proxy.mjs locally; an Azure Function
 * in production via NEXT_PUBLIC_ACCOUNT_API_BASE, inlined at build time). The
 * Microsoft Graph APIs that change a sign-in identity or a phone authentication
 * method all need an APP-ONLY token (there is no delegated self-service
 * permission for external-tenant customers), so the proxy holds the client
 * secret + Graph token server-side and the SPA never sees them. The SPA only
 * ever sends the signed-in user's ID token; the proxy verifies it and derives
 * the Graph user id from its `oid`, so a caller can only manage their own
 * account.
 */
export function accountApiBase(): string {
    return process.env.NEXT_PUBLIC_ACCOUNT_API_BASE ?? `${resolveProxyOrigin()}/api`;
}

/**
 * Whether the account self-service feature can work where the app is running.
 * The default API base is the local proxy, which only exists in dev — on a
 * deployed site without NEXT_PUBLIC_ACCOUNT_API_BASE the links would dead-end
 * in "could not reach the proxy", so the UI hides them instead. Call from an
 * effect (not during render) to avoid hydration mismatches with the static
 * export.
 *
 * Two dev hosts are recognised: plain `localhost` (`npm run dev`) and the
 * passkey rp domain `auth.<tenant>.ciamlogin.com` (`npm run dev:passkey`). The
 * passkey server already fronts the same local proxy (the proxy's CORS allowlist
 * includes that origin), so enabling the account features there lets a single
 * `npm run dev:passkey` host both passkeys and account management — the two dev
 * servers can't run together anyway since both bind port 3000.
 */
export function accountFeatureAvailable(): boolean {
    if (process.env.NEXT_PUBLIC_ACCOUNT_API_BASE) return true;
    if (typeof window === "undefined") return false;
    const host = window.location.hostname;
    return host === "localhost" || host === passkeyRpId || host.endsWith(`.${passkeyRpId}`);
}

/**
 * Claims challenge demanding fresh MFA ("ngcmfa" = next-gen-credential MFA).
 * Every account-change request carries this so Entra only issues the token if
 * the user completed MFA recently (otherwise the silent request fails with
 * invalid_grant / interaction_required and the app redirects for MFA). Because
 * claims-based caching is disabled by default, MSAL always goes to the network
 * for these requests, so the freshness check is enforced on every operation.
 */
export const ngcmfaClaims = JSON.stringify({
    id_token: { amr: { essential: true, values: ["ngcmfa"] } },
    access_token: { amr: { essential: true, values: ["ngcmfa"] } },
});

/* ------------------------------------------------------------------------- *
 * Native-auth sign-up (in-app React forms; ported from the native-auth sample)
 *
 * NOTE: this section must stay BELOW resolveProxyOrigin/PROXY_PORT —
 * customAuthConfig is initialized at module evaluation, so anything it calls
 * must already be defined (a `const` above it is fine; one below it is a
 * temporal-dead-zone ReferenceError in the browser).
 * ------------------------------------------------------------------------- */

/**
 * Where the custom-auth SDK reaches the native-auth REST endpoints. They send
 * no CORS headers, so a same-origin-ish proxy is required:
 *   - plain localhost dev        -> local-proxy.mjs on :3001 (npm run proxy)
 *   - unified HTTPS dev hosts    -> https://api.<tenant>.ciamlogin.com:3001
 *   - deployed                   -> the site's own /api (requires a backend that
 *                                   forwards /signup + /oauth2 to ciamlogin.com,
 *                                   like the native-auth sample's SWA function)
 */
function resolveNativeAuthProxyUrl(): string {
    if (typeof window === "undefined") {
        // Build-time prerender only — never used for live requests.
        return "http://localhost:3001/api";
    }
    const host = window.location.hostname;
    const rpId = `${TENANT_SUBDOMAIN}.ciamlogin.com`;
    if (host === "localhost" || host === "127.0.0.1" || host === rpId || host.endsWith(`.${rpId}`)) {
        return `${resolveProxyOrigin()}/api`;
    }
    return `${window.location.origin}/api`;
}

/**
 * Configuration for CustomAuthPublicClientApplication (the native-auth SDK),
 * used ONLY by the /sign-up flow. Same app registration and tenant as
 * msalConfig — native auth is enabled on it (the native-auth sample runs
 * against it) — and the same sessionStorage cache location.
 *
 * After sign-up completes the page does NOT use the native flow's tokens: it
 * hands off to a hosted `loginRedirect` seeded with login_hint (native auth
 * cannot mint the Entra web session cookie, so signing in via the hosted page
 * is what gives this app its normal browser SSO session).
 */
export const customAuthConfig: CustomAuthConfiguration = {
    customAuth: {
        challengeTypes: ["password", "oob", "redirect"],
        capabilities: ["mfa_required", "registration_required"],
        authApiProxyUrl: resolveNativeAuthProxyUrl(),
    },
    auth: {
        clientId: CLIENT_ID,
        authority: `https://${TENANT_SUBDOMAIN}.ciamlogin.com/${TENANT_ID}`,
        redirectUri: "/",
        postLogoutRedirectUri: "/",
        navigateToLoginRequestUrl: false,
    },
    cache: {
        cacheLocation: "sessionStorage",
        storeAuthStateInCookie: false,
    },
};
