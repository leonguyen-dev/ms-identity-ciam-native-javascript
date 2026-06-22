const http = require("http");
const https = require("https");
const url = require("url");
const crypto = require("crypto");
const proxyConfig = require("./proxy.config");

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
    constructor(status, message) {
        super(message);
        this.status = status;
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
});
