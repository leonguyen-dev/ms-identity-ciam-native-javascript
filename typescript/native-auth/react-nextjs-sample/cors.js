const http = require("http");
const https = require("https");
const url = require("url");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const proxyConfig = require("./proxy.config");

/**
 * Minimal .env.local loader so secrets (the app-only Graph client secret, the
 * Azure Communication Services connection string) stay out of the repo
 * (.env* is gitignored). Mirrors the browser-delegated local-proxy.mjs loader.
 */
function loadEnvLocal() {
    const envPath = path.join(process.cwd(), ".env.local");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match || match[1] in process.env) continue;
        let value = match[2].trim();
        const quote = value[0];
        if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
            value = value.slice(1, -1);
        } else {
            // Unquoted: strip inline comments + trailing whitespace (a secret pasted
            // with a stray trailing space otherwise fails with an opaque AADSTS7000215).
            value = value.replace(/\s+#.*$/, "").trim();
        }
        process.env[match[1]] = value;
    }
}
loadEnvLocal();

/**
 * Local-dev mirror of the server-side sign-up attribute validation.
 *
 * In production this runs in the SWA function (api/src/attributeValidation.ts, invoked
 * by authProxy.ts). Locally cors.js is the /api proxy, so the same /api/validate-attributes
 * call must be answered here. KEEP THIS IN SYNC with api/src/attributeValidation.ts.
 */
const MIN_AGE = 16;
const MAX_AGE = 120;
const NAME_MAX = 64;
const HAS_LETTER = /\p{L}/u;

function hasForbiddenChar(value) {
    if (value.includes("<") || value.includes(">")) {
        return true;
    }
    for (const ch of value) {
        if (ch.charCodeAt(0) < 0x20) {
            return true;
        }
    }
    return false;
}

function validateName(value, field, label, errors) {
    const v = typeof value === "string" ? value.trim() : "";
    if (v.length === 0) {
        errors[field] = `Please provide your ${label}.`;
        return;
    }
    if (v.length > NAME_MAX) {
        errors[field] = `Your ${label} must be ${NAME_MAX} characters or fewer.`;
        return;
    }
    if (hasForbiddenChar(v) || !HAS_LETTER.test(v)) {
        errors[field] = `Please enter a valid ${label}.`;
    }
}

function ageOn(dob, now) {
    let age = now.getUTCFullYear() - dob.getUTCFullYear();
    const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
    if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
        age--;
    }
    return age;
}

function validateDateOfBirth(value, errors) {
    if (typeof value !== "string" || value.trim().length === 0) {
        errors.dateOfBirth = "Please provide your date of birth.";
        return;
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) {
        errors.dateOfBirth = "Please enter a valid date of birth.";
        return;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const dob = new Date(Date.UTC(year, month - 1, day));
    if (dob.getUTCFullYear() !== year || dob.getUTCMonth() !== month - 1 || dob.getUTCDate() !== day) {
        errors.dateOfBirth = "Please enter a valid date of birth.";
        return;
    }
    const now = new Date();
    if (dob.getTime() > now.getTime()) {
        errors.dateOfBirth = "Your date of birth can't be in the future.";
        return;
    }
    const age = ageOn(dob, now);
    if (age < MIN_AGE) {
        errors.dateOfBirth = `You must be at least ${MIN_AGE} years old to create an account.`;
        return;
    }
    if (age > MAX_AGE) {
        errors.dateOfBirth = "Please enter a valid date of birth.";
    }
}

function validateSignUpAttributes(input) {
    const errors = {};
    const data = input || {};
    validateName(data.givenName, "givenName", "given name", errors);
    validateName(data.surname, "surname", "family name", errors);
    validateDateOfBirth(data.dateOfBirth, errors);
    if (data.termsAccepted !== true) {
        errors.termsAccepted = "You must agree to the terms and conditions.";
    }
    const valid = Object.keys(errors).length === 0;
    return { valid, errors, message: valid ? undefined : Object.values(errors)[0] };
}

/* ===================== webview SSO (Feature B / B2) ======================= *
 *
 * Native app → in-app web content (embedded webview) SSO. This implements the
 * supported pattern documented at
 * https://learn.microsoft.com/entra/identity-platform/how-to-native-authentication-webview-sso:
 *
 *   1. The user signs in with native authentication (the React UI in this app,
 *      driven by the @azure/msal-browser/custom-auth SDK).
 *   2. Before loading the web view, the app retrieves a valid token from the SDK
 *      and injects `Authorization: Bearer <token>` onto the web view's request.
 *      A browser can't set a header on an <iframe> navigation the way a native
 *      WebView/WKWebView can, so the "native app shell" (src/app/webview/page.tsx)
 *      presents the bearer with a credentialed fetch to POST /api/webview/session —
 *      the one place the token is injected.
 *   3. This backend validates the token's signature/iss/aud/tid/exp against the
 *      tenant JWKS and issues a standard HttpOnly session cookie.
 *   4. The web view then loads GET /webview, gated on that cookie alone (no token
 *      re-injection), so the session persists across in-webview navigation
 *      (GET /webview → GET /webview/profile) with no second prompt.
 *
 * SameSite=Lax is sufficient locally: the app (:3000) and this web resource
 * (:3001) are the SAME SITE (both `localhost`; SameSite ignores the port), so the
 * cookie is first-party on the iframe's requests and isn't affected by
 * third-party-cookie blocking. In production the app and the web resource live
 * under one registrable domain (a single custom URL domain), which preserves that
 * property; a genuinely cross-site embed would need partitioned cookies (CHIPS).
 *
 * The token validated here is the SPA's ID token (its `aud` is this clientId),
 * which keeps the sample runnable with no extra Entra setup. In production the web
 * resource would expose an API scope on the shared app registration, the app would
 * call the SDK's getAccessToken({ scopes }) for that scope, and this backend would
 * validate the access token's `aud` — the validation logic is otherwise identical.
 */

const TENANT_SUBDOMAIN = proxyConfig.tenantSubdomain;
const TENANT_ID = proxyConfig.tenantId;
const CLIENT_ID = proxyConfig.clientId;
const CLOCK_SKEW_SECONDS = 5 * 60;

const WEBVIEW_COOKIE_NAME = "st_webview_session";
const WEBVIEW_SESSION_TTL_SECONDS = 60 * 60;
// Per-process signing key: restarting the proxy invalidates live webview
// sessions (the user just reopens the demo). Never leaves this process.
const webviewSessionKey = crypto.randomBytes(32);

class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code; // machine-readable hint for the SPA (e.g. "mfa_required")
    }
}

let oidcMetadata = null; // { issuer, keys, fetchedAt }

async function getOidcMetadata(forceKeyRefresh = false) {
    const oneHour = 60 * 60 * 1000;
    if (oidcMetadata && !forceKeyRefresh && Date.now() - oidcMetadata.fetchedAt < oneHour) {
        return oidcMetadata;
    }
    const configUrl = `https://${TENANT_SUBDOMAIN}.ciamlogin.com/${TENANT_ID}/v2.0/.well-known/openid-configuration`;
    const configResponse = await fetch(configUrl);
    if (!configResponse.ok) {
        throw new HttpError(502, `Could not fetch OIDC metadata (HTTP ${configResponse.status}).`);
    }
    const config = await configResponse.json();
    if (!config.issuer || !config.jwks_uri) {
        throw new HttpError(502, "OIDC metadata is missing issuer/jwks_uri.");
    }
    const jwksResponse = await fetch(config.jwks_uri);
    if (!jwksResponse.ok) {
        throw new HttpError(502, `Could not fetch tenant JWKS (HTTP ${jwksResponse.status}).`);
    }
    const jwks = await jwksResponse.json();
    oidcMetadata = { issuer: config.issuer, keys: jwks.keys ?? [], fetchedAt: Date.now() };
    return oidcMetadata;
}

/** Validate the injected Bearer token against the tenant JWKS; return its claims. */
async function verifyBearerToken(req) {
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) throw new HttpError(401, "Missing Bearer token.");

    const parts = token.split(".");
    if (parts.length !== 3) throw new HttpError(401, "Malformed token.");
    const [headerB64, payloadB64, signatureB64] = parts;

    let header, payload;
    try {
        header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
        payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch {
        throw new HttpError(401, "Malformed token.");
    }

    let metadata = await getOidcMetadata();
    let jwk = metadata.keys.find((key) => key.kid === header.kid);
    if (!jwk) {
        // Key rollover — refetch the JWKS once before giving up.
        metadata = await getOidcMetadata(true);
        jwk = metadata.keys.find((key) => key.kid === header.kid);
        if (!jwk) throw new HttpError(401, "Unknown signing key.");
    }

    const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
    const signatureValid = crypto.verify(
        "RSA-SHA256",
        Buffer.from(`${headerB64}.${payloadB64}`),
        publicKey,
        Buffer.from(signatureB64, "base64url")
    );
    if (!signatureValid) throw new HttpError(401, "Invalid token signature.");

    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== metadata.issuer) throw new HttpError(401, "Invalid token issuer.");
    if (payload.aud !== CLIENT_ID) throw new HttpError(401, "Invalid token audience.");
    if (payload.tid !== TENANT_ID) throw new HttpError(401, "Invalid token tenant.");
    if ((payload.exp ?? 0) < now - CLOCK_SKEW_SECONDS) throw new HttpError(401, "Token expired.");
    if ((payload.nbf ?? 0) > now + CLOCK_SKEW_SECONDS) throw new HttpError(401, "Token not yet valid.");
    if (!payload.oid) throw new HttpError(401, "Token has no oid claim.");

    return payload;
}

function makeWebviewCookie(claims) {
    const exp = Math.floor(Date.now() / 1000) + WEBVIEW_SESSION_TTL_SECONDS;
    const payload = Buffer.from(JSON.stringify({ ...claims, exp })).toString("base64url");
    const sig = crypto.createHmac("sha256", webviewSessionKey).update(payload).digest("base64url");
    return (
        `${WEBVIEW_COOKIE_NAME}=${payload}.${sig}; HttpOnly; SameSite=Lax; Path=/; ` +
        `Max-Age=${WEBVIEW_SESSION_TTL_SECONDS}`
    );
}

/** Validate the signed session cookie; returns the claims or null. */
function readWebviewCookie(req) {
    const header = req.headers.cookie ?? "";
    const cookie = header.split(/;\s*/).find((c) => c.startsWith(`${WEBVIEW_COOKIE_NAME}=`));
    if (!cookie) return null;
    const value = cookie.slice(WEBVIEW_COOKIE_NAME.length + 1);
    const dot = value.lastIndexOf(".");
    if (dot <= 0) return null;
    const payload = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    const expected = crypto.createHmac("sha256", webviewSessionKey).update(payload).digest("base64url");
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
    return claims;
}

const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

/** Branded HTML shown inside the webview once the cookie is established. */
function webviewContentHtml(session, { profile = false } = {}) {
    const email = escapeHtml(session.email ?? session.oid ?? "unknown");
    const heading = profile ? "Webview · Profile" : "Webview · Home";
    const body = profile
        ? `<p>This is a <strong>second page</strong> inside the webview. You navigated here
             from the home page with <strong>no token re-injection</strong> — the request
             carried only the <code>HttpOnly</code> session cookie set on the first load.
             That is the "persist the session across navigation" guarantee.</p>
           <p><a href="/webview">&larr; Back to webview home</a></p>`
        : `<p>You are signed in <strong>inside the embedded web content</strong> as
             <strong>${email}</strong> — with <strong>no second prompt</strong>.</p>
           <p>The native app shell acquired a token, injected it as a Bearer header on the
             first request, and this backend exchanged it for an <code>HttpOnly</code>
             session cookie. Follow the link below to prove the session persists across
             navigation without re-injecting the token:</p>
           <p><a href="/webview/profile">Go to the profile page &rarr;</a></p>`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${heading}</title>
  <style>
    body { margin:0; font-family:'Nunito',-apple-system,'Segoe UI',Roboto,sans-serif; color:#292929; background:#ffffff; }
    header { background:#098851; color:#fff; padding:1rem 1.5rem; font-size:1.125rem; font-weight:700; }
    main { padding:1.5rem; line-height:1.6; }
    code { background:#f0f0f0; padding:0.1rem 0.3rem; border-radius:0.2rem; }
    a { color:#267151; font-weight:700; }
    .badge { display:inline-block; background:#e6f4ec; color:#098851; font-weight:700; padding:0.25rem 0.6rem; border-radius:1rem; font-size:0.8125rem; }
  </style>
</head>
<body>
  <header>Service Tasmania — in-app web content</header>
  <main>
    <p><span class="badge">webview session active</span></p>
    ${body}
  </main>
</body>
</html>`;
}

/** Shown in the iframe when no valid session cookie is present. */
function webviewUnauthedHtml() {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<style>body{margin:0;font-family:'Nunito',-apple-system,'Segoe UI',sans-serif;color:#292929;padding:1.5rem;line-height:1.6;}</style>
</head><body>
  <p>No webview session. The native app shell must establish one first
     (POST <code>/api/webview/session</code> with a Bearer token).</p>
</body></html>`;
}

/**
 * Handle the webview SSO routes. The session endpoint validates the injected
 * bearer and sets the cookie; the content pages are an iframe navigation that
 * carries only that cookie (no Authorization header), so they are gated on it.
 * `corsHeaders` already reflects the caller's origin (credentialed fetch needs a
 * concrete origin, never "*").
 */
async function handleWebview(req, reqUrl, res, corsHeaders) {
    if (req.method === "POST" && reqUrl.pathname === `${proxyConfig.localApiPath}/webview/session`) {
        try {
            const user = await verifyBearerToken(req);
            const email = [user.signin_email, user.email, user.preferred_username].find(
                (e) => typeof e === "string" && e.includes("@")
            );
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Set-Cookie": makeWebviewCookie({ oid: user.oid, email, name: user.name ?? null }),
                ...corsHeaders,
            });
            res.end(JSON.stringify({ ok: true, user: { email: email ?? null, name: user.name ?? null } }));
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 500;
            if (status === 500) console.error(error);
            res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders });
            res.end(JSON.stringify({ error: { message: error.message } }));
        }
        return;
    }

    if (req.method === "GET" && (reqUrl.pathname === "/webview" || reqUrl.pathname === "/webview/profile")) {
        const session = readWebviewCookie(req);
        if (!session) {
            res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
            res.end(webviewUnauthedHtml());
            return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(webviewContentHtml(session, { profile: reqUrl.pathname === "/webview/profile" }));
        return;
    }

    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><p>Not found.</p>");
}

/* ===================== account self-management ============================ *
 *
 * Change the signed-in user's sign-in email or mobile MFA number against
 * Microsoft Graph. Ported from the browser-delegated sample's local-proxy.mjs —
 * the Graph APIs behind these need an APP-ONLY token (no delegated self-service
 * permission exists for external-tenant customers), so the client secret and the
 * Graph token must never reach the browser. This proxy holds them and exposes a
 * few narrow routes:
 *
 *   GET  /api/account                       read the caller's email + mobile number
 *   POST /api/account/signin-name/send-otp  email a verification code to a NEW
 *                                           sign-in email (proves mailbox control)
 *   POST /api/account/signin-name           change sign-in email (fresh token + OTP)
 *   POST /api/account/phone                 change mobile number (fresh token)
 *
 * Every request carries the signed-in user's ID token as a Bearer token (the same
 * verifyBearerToken machinery the webview routes use); the Graph user id is taken
 * from its `oid`, so a caller can only ever manage their own account. Password
 * changes are deliberately absent — Graph has no app-only path to set a user's own
 * password — so the account page routes those into the native /reset-password flow.
 *
 * Graph app-role permissions the app registration needs (admin-consented):
 *   - User.ReadWrite.All           (read user + sync mail/otherMails)
 *   - User.ManageIdentities.All    (PATCH identities = change sign-in name)
 *   - UserAuthenticationMethod.ReadWrite.All (read + update phone/email methods)
 *
 * Local/demo use only — host the same logic in a real backend for production.
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// External ID customer sign-in identities are surfaced/managed on beta; v1.0 can
// return an empty identities[] for these accounts.
const GRAPH_BETA = "https://graph.microsoft.com/beta";
// Well-known mobile phone authentication-method id (same for every user).
const MOBILE_PHONE_METHOD_ID = "3179e48a-750b-4051-897c-87b9720928f7";

// How fresh the user's token must be for a change. Native auth has no step-up MFA,
// but the native sign-in itself included SMS MFA, so a recently-issued token means
// "MFA happened recently". When the token is older the proxy answers mfa_required
// and the page asks the user to sign in again.
const FRESH_MFA_MAX_AGE_SECONDS = 15 * 60;

// New-email verification OTP.
const OTP_TTL_SECONDS = 10 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 30;

const ACCOUNT_CLIENT_SECRET =
    process.env.ACCOUNT_CLIENT_SECRET || process.env.PASSKEY_CLIENT_SECRET;
const ACS_CONNECTION_STRING = process.env.COMMUNICATION_SERVICES_CONNECTION_STRING;
const ACS_SENDER_ADDRESS = process.env.COMMUNICATION_SERVICES_SENDER_ADDRESS;
const MAIL_SENDER_DISPLAY_NAME = process.env.MAIL_SENDER_DISPLAY_NAME || "myServiceTas";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// E.164-ish: "+", country code, optional spaces. Graph wants "+{cc} {number}".
const PHONE_RE = /^\+[0-9][0-9\s]{6,17}$/;

/* ------------------------------ Graph client ------------------------------ */

let appTokenCache = null; // { token, expiresAt }

async function getAppToken(forceRefresh = false) {
    if (!ACCOUNT_CLIENT_SECRET) {
        throw new HttpError(
            500,
            "Account management is not configured. Set ACCOUNT_CLIENT_SECRET in .env.local (see README, 'My account' section)."
        );
    }
    if (!forceRefresh && appTokenCache && Date.now() < appTokenCache.expiresAt) {
        return appTokenCache.token;
    }
    const body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: ACCOUNT_CLIENT_SECRET,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
    });
    const response = await fetch(
        `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
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
        // App-role grants made while the proxy is running only show up in a fresh
        // token (the cached one is good for ~1h). Retry once with a new token.
        result = await attempt(true);
    }
    return result;
}

/** Throw a friendly HttpError carrying the Graph error message when a call fails. */
function assertGraphOk(result, fallback) {
    if (result.ok) return;
    const message = result.json?.error?.message ?? result.json?.error?.code ?? fallback;
    throw new HttpError(result.status === 0 ? 502 : result.status, message);
}

// amr values that indicate a second factor. Only consulted when a token actually
// carries amr — Entra External ID CIAM tokens usually don't.
const MFA_AMR_VALUES = [
    "ngcmfa", "mfa", "otp", "sms", "tel", "fido",
    "face", "fpt", "iris", "retina", "sc", "pop", "hwk",
];

/**
 * Backstop the freshness requirement on a mutating call. Native auth has no
 * claims-challenge step-up, so this leans on `iat` age: the native sign-in
 * included SMS MFA, so a recently-issued token means MFA happened recently. CIAM
 * tokens carry no amr/auth_time to re-verify independently, so when amr is absent
 * we trust iat freshness; when present it must name a second factor.
 */
function requireFreshMfa(payload) {
    const now = Math.floor(Date.now() / 1000);
    const freshEnough = (payload.iat ?? 0) >= now - FRESH_MFA_MAX_AGE_SECONDS;
    const amrOk =
        !Array.isArray(payload.amr) ||
        payload.amr.some((m) => MFA_AMR_VALUES.includes(m));

    if (!freshEnough || !amrOk) {
        throw new HttpError(
            401,
            "For your security, please sign out and sign in again, then retry this change.",
            "mfa_required"
        );
    }
}

/* --------------------------- new-email OTP store -------------------------- */

// Pending verification codes, keyed by the caller's oid. In-memory only: a proxy
// restart drops pending codes and the user simply requests a new one.
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

/**
 * Validate a submitted code for this oid+email and consume it on success. Throws
 * HttpError("otp_invalid"/"otp_required") otherwise. A wrong code burns an
 * attempt; exhausting attempts (or expiry) drops the entry.
 */
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

/** Generate, store, and email a verification code for a new sign-in email. */
async function sendSignInOtp(oid, email) {
    if (!ACS_CONNECTION_STRING || !ACS_SENDER_ADDRESS) {
        throw new HttpError(
            500,
            "Email provider not configured. Set COMMUNICATION_SERVICES_CONNECTION_STRING and COMMUNICATION_SERVICES_SENDER_ADDRESS in .env.local."
        );
    }
    // Lazy-require so the proxy still starts (and the rest of the sample works)
    // when @azure/communication-email isn't installed.
    let EmailClient;
    try {
        ({ EmailClient } = require("@azure/communication-email"));
    } catch {
        throw new HttpError(
            500,
            "The email package isn't installed. Run `npm install` (it adds @azure/communication-email)."
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

    const { subject, html, plainText } = buildOtpEmail(email, code, MAIL_SENDER_DISPLAY_NAME);
    const client = new EmailClient(ACS_CONNECTION_STRING);
    try {
        await client.beginSend({
            senderAddress: ACS_SENDER_ADDRESS,
            recipients: { to: [{ address: email }] },
            content: { subject, html, plainText },
        });
    } catch (err) {
        pendingOtps.delete(oid); // no email went out — don't strand a dead code
        console.error("Failed to send verification email via ACS:", err);
        throw new HttpError(502, "Could not send the verification email. Please try again.");
    }
}

/**
 * Branded verification email for a new sign-in address. Mirrors the browser-
 * delegated proxy's template (table-based, inline styles for email-client compat).
 */
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

/* --------------------------- account operations --------------------------- */

const USER_SELECT = "displayName,identities,userPrincipalName,mail,otherMails";

/**
 * Find the email the user actually signs in with. Returns
 * { kind: "identity", index, value } | { kind: "upn", value } | null.
 */
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

/**
 * Get the account's real identities[]. App-only GET often returns identities: []
 * for External ID CIAM accounts even when an emailAddress identity exists — a
 * $filter on identities bypasses that masking. Probes the profile `mail` first,
 * then the email claim from the caller's verified token, then otherMails.
 */
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

/** Read the user's current sign-in email (and username, if any) + mobile number. */
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

/**
 * Change the sign-in email "everywhere relevant": the sign-in identity (primary
 * target; failure aborts), the email OTP method, and the mail/otherMails profile
 * fields (best-effort, so the verification email + token email claim line up).
 * Returns { synced, warnings }. The literal userPrincipalName GUID is left alone.
 */
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

    // 2. Email one-time-passcode method (create one if absent so the new address
    //    is the explicit OTP target either way).
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

/**
 * Change the mobile MFA number. Update the existing mobile method if present;
 * otherwise create one (a phone's type can't be changed, so always target mobile).
 */
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

/* ---------------------------- account routing ----------------------------- */

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

function sendJson(res, status, body, corsHeaders) {
    res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/**
 * Handle the account self-management routes. Dispatched before the CIAM
 * passthrough below (these must not be proxied upstream). Every route verifies the
 * caller's Bearer token; the two mutations additionally require a fresh token.
 */
async function handleAccount(req, reqUrl, res, corsHeaders) {
    const apiBase = proxyConfig.localApiPath;
    const route = `${req.method} ${reqUrl.pathname}`;
    try {
        const user = await verifyBearerToken(req);
        const oid = user.oid;
        // Email claim from the verified token — a probe value when the app-only
        // read masks identities[] (see getRealIdentities).
        const tokenEmail = [user.email, user.preferred_username].find(
            (e) => typeof e === "string" && e.includes("@")
        );

        if (route === `GET ${apiBase}/account`) {
            const summary = await getAccountSummary(oid, tokenEmail);
            sendJson(res, 200, summary, corsHeaders);
        } else if (route === `POST ${apiBase}/account/signin-name/send-otp`) {
            // Emailing the code is low-risk and must precede the fresh-token gate,
            // so this only needs a valid token (the gate stays on the change itself).
            const body = await parseJsonBody(req);
            const email = String(body.email ?? "").trim();
            if (!EMAIL_RE.test(email)) {
                throw new HttpError(400, "Enter a valid email address.");
            }
            await sendSignInOtp(oid, email);
            sendJson(res, 200, {
                ok: true,
                message: `We've emailed a verification code to ${email}.`,
            }, corsHeaders);
        } else if (route === `POST ${apiBase}/account/signin-name`) {
            requireFreshMfa(user);
            const body = await parseJsonBody(req);
            const email = String(body.email ?? "").trim();
            if (!EMAIL_RE.test(email)) {
                throw new HttpError(400, "Enter a valid email address.");
            }
            verifyOtp(oid, email, String(body.otp ?? "").trim());
            const { synced, warnings } = await changeSignInName(oid, email, tokenEmail);
            let message = `Sign-in email changed to ${email} (updated: ${synced.join(", ")}). Sign out and back in to refresh your token.`;
            if (warnings.length) {
                message += ` Note: ${warnings.join("; ")}`;
            }
            sendJson(res, 200, { ok: true, message }, corsHeaders);
        } else if (route === `POST ${apiBase}/account/phone`) {
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
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error(error);
        sendJson(res, status, { error: { message: error.message, code: error.code } }, corsHeaders);
    }
}

const extraHeaders = [
    "x-client-SKU",
    "x-client-VER",
    "x-client-OS",
    "x-client-CPU",
    "x-client-current-telemetry",
    "x-client-last-telemetry",
    "client-request-id",
];
http.createServer((req, res) => {
    const reqUrl = url.parse(req.url);
    const domain = url.parse(proxyConfig.proxy).hostname;

    // Set CORS headers for all responses including OPTIONS. Reflect the caller's
    // origin rather than "*": the webview session fetch is credentialed
    // (credentials: "include", so its Set-Cookie is stored), and browsers reject a
    // credentialed response whose Allow-Origin is "*". Reflecting is no broader
    // than the "*" this dev proxy already allowed.
    const corsHeaders = {
        "Access-Control-Allow-Origin": req.headers.origin || "*",
        Vary: "Origin",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, " + extraHeaders.join(", "),
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400", // 24 hours
    };

    // Handle preflight OPTIONS request
    if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
    }

    // Webview SSO (Feature B / B2). Dispatched before the CIAM passthrough below:
    // /api/webview/session runs its own token verification (it must not be proxied
    // to CIAM), and the /webview content pages don't live under /api at all.
    if (
        reqUrl.pathname === `${proxyConfig.localApiPath}/webview/session` ||
        reqUrl.pathname === "/webview" ||
        reqUrl.pathname === "/webview/profile"
    ) {
        handleWebview(req, reqUrl, res, corsHeaders);
        return;
    }

    // Account self-management (Graph-backed). Dispatched before the CIAM
    // passthrough: these routes are served here, not proxied upstream.
    if (reqUrl.pathname.startsWith(`${proxyConfig.localApiPath}/account`)) {
        handleAccount(req, reqUrl, res, corsHeaders);
        return;
    }

    // Server-side attribute validation endpoint — answered locally, not proxied to CIAM.
    if (req.method === "POST" && reqUrl.pathname === `${proxyConfig.localApiPath}/validate-attributes`) {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
            let result;
            try {
                result = validateSignUpAttributes(JSON.parse(raw || "{}"));
            } catch {
                result = { valid: false, errors: {}, message: "Invalid request body." };
            }
            res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
        });
        return;
    }

    if (reqUrl.pathname.startsWith(proxyConfig.localApiPath)) {
        const targetUrl = proxyConfig.proxy + reqUrl.pathname?.replace(proxyConfig.localApiPath, "") + (reqUrl.search || "");

        console.log("Incoming request -> " + req.url + " ===> " + reqUrl.pathname);

        const newHeaders = {};
        for (let [key, value] of Object.entries(req.headers)) {
            if (key !== 'origin') {
                newHeaders[key] = value;
            }
        }

        const proxyReq = https.request(
            targetUrl, // CodeQL [SM04580] The newly generated target URL utilizes the configured proxy URL to resolve the CORS issue and will be used exclusively for demo purposes and run locally.
            {
                method: req.method,
                headers: {
                    ...newHeaders,
                    host: domain,
                },
            },
            (proxyRes) => {
                res.writeHead(proxyRes.statusCode, {
                    ...proxyRes.headers,
                    ...corsHeaders,
                });

                proxyRes.pipe(res);
            }
        );

        proxyReq.on("error", (err) => {
            console.error("Error with the proxy request:", err);
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Proxy error.");
        });

        req.pipe(proxyReq);
    } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
    }
}).listen(proxyConfig.port, () => {
    console.log("CORS proxy running on http://localhost:3001");
    console.log("Proxying from " + proxyConfig.localApiPath + " ===> " + proxyConfig.proxy);
    console.log(
        "  account self-management: " +
            (ACCOUNT_CLIENT_SECRET
                ? "enabled (app-only Graph)" +
                  (ACS_CONNECTION_STRING && ACS_SENDER_ADDRESS ? " + email OTP" : " (set COMMUNICATION_SERVICES_* for email OTP)")
                : "disabled (set ACCOUNT_CLIENT_SECRET in .env.local)")
    );
});
