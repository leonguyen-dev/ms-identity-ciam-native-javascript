import { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import crypto from "crypto";
import { HttpError, TENANT_ID, CLIENT_ID, TokenClaims, verifyCiamToken } from "./tokenAuth";

/**
 * Webview SSO (Feature B / B2) for Azure Static Web Apps — the deployed-host
 * counterpart of the webview routes in cors.js.
 *
 * Native app → in-app web content SSO, per
 * https://learn.microsoft.com/entra/identity-platform/how-to-native-authentication-webview-sso:
 *
 *   1. The user signs in with native authentication (the React UI).
 *   2. The native app shell (src/app/webview/page.tsx) retrieves a token and POSTs
 *      it as `Authorization: Bearer <token>` to /api/webview/session — the one
 *      place the token is injected.
 *   3. This backend validates the token's signature/iss/aud/tid/exp against the
 *      tenant JWKS and issues an HttpOnly session cookie.
 *   4. The webview iframe then loads GET /api/webview/content, gated on that cookie
 *      alone (no token re-injection), so the session persists across in-webview
 *      navigation (content -> content/profile) with no second prompt.
 *
 * On SWA the app and this web resource share one origin, so the session cookie is
 * first-party on the iframe's requests (SameSite=Lax suffices) and no CORS headers
 * are needed. Unlike cors.js, the content lives under /api/webview/content rather
 * than /webview, because SWA serves only /api/* from managed functions (/webview
 * is the React app shell page itself).
 *
 * The token validated here is the SPA's ID token (its `aud` is this clientId),
 * which keeps the sample runnable with no extra Entra setup. In production the web
 * resource would expose an API scope and this backend would validate the access
 * token's `aud` — the validation logic is otherwise identical.
 */

const WEBVIEW_COOKIE_NAME = "st_webview_session";
const WEBVIEW_SESSION_TTL_SECONDS = 60 * 60;

// HMAC key for the session cookie. Set WEBVIEW_SESSION_SECRET in the SWA app
// settings for a real secret; otherwise we derive a deterministic key from the
// tenant/client ids so cookies stay valid across function instances and cold
// starts (a per-process random key would intermittently break the iframe when the
// session POST and content GET land on different instances). The cookie only gates
// a demo content page that shows the email the cookie itself carries — the bearer
// token was already validated when it was issued — so a derived key is an
// acceptable POC tradeoff.
const webviewSessionKey = crypto
    .createHash("sha256")
    .update(process.env.WEBVIEW_SESSION_SECRET || `${TENANT_ID}:${CLIENT_ID}:st-webview-session`)
    .digest();

/**
 * Validate the injected token against the tenant JWKS; return its claims.
 *
 * The token arrives in the custom `X-Webview-Token` header, NOT `Authorization`:
 * Azure Static Web Apps reserves `Authorization` for its own platform auth and
 * replaces it with an internal HS256 token before the request reaches this managed
 * function, so a CIAM bearer placed there never survives — and reading it back as a
 * fallback would only pick up SWA's own token. A custom header passes through
 * untouched, so it's the only reliable channel here. The JWKS validation itself
 * lives in tokenAuth.ts, shared with the account routes.
 */
function verifyBearerToken(request: HttpRequest): Promise<TokenClaims> {
    return verifyCiamToken(request.headers.get("x-webview-token"));
}

interface SessionClaims {
    oid: string;
    email: string | null;
    name: string | null;
    exp: number;
}

function makeWebviewCookieValue(claims: Omit<SessionClaims, "exp">): string {
    const exp = Math.floor(Date.now() / 1000) + WEBVIEW_SESSION_TTL_SECONDS;
    const payload = Buffer.from(JSON.stringify({ ...claims, exp })).toString("base64url");
    const sig = crypto.createHmac("sha256", webviewSessionKey).update(payload).digest("base64url");
    return `${payload}.${sig}`;
}

/** Validate the signed session cookie; returns the claims or null. */
function readWebviewCookie(request: HttpRequest): SessionClaims | null {
    const header = request.headers.get("cookie") ?? "";
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
    let claims: SessionClaims;
    try {
        claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
        return null;
    }
    if ((claims.exp ?? 0) < Math.floor(Date.now() / 1000)) return null;
    return claims;
}

const escapeHtml = (s: string): string =>
    String(s).replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
    );

/** Branded HTML shown inside the webview once the cookie is established. */
function webviewContentHtml(session: SessionClaims, { profile = false } = {}): string {
    const email = escapeHtml(session.email ?? session.oid ?? "unknown");
    const heading = profile ? "Webview · Profile" : "Webview · Home";
    const body = profile
        ? `<p>This is a <strong>second page</strong> inside the webview. You navigated here
             from the home page with <strong>no token re-injection</strong> — the request
             carried only the <code>HttpOnly</code> session cookie set on the first load.
             That is the "persist the session across navigation" guarantee.</p>
           <p><a href="/api/webview/content">&larr; Back to webview home</a></p>`
        : `<p>You are signed in <strong>inside the embedded web content</strong> as
             <strong>${email}</strong> — with <strong>no second prompt</strong>.</p>
           <p>The native app shell acquired a token, injected it as a Bearer header on the
             first request, and this backend exchanged it for an <code>HttpOnly</code>
             session cookie. Follow the link below to prove the session persists across
             navigation without re-injecting the token:</p>
           <p><a href="/api/webview/content/profile">Go to the profile page &rarr;</a></p>`;
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
function webviewUnauthedHtml(): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<style>body{margin:0;font-family:'Nunito',-apple-system,'Segoe UI',sans-serif;color:#292929;padding:1.5rem;line-height:1.6;}</style>
</head><body>
  <p>No webview session. The native app shell must establish one first
     (POST <code>/api/webview/session</code> with a Bearer token).</p>
</body></html>`;
}

/**
 * Handle the webview SSO routes (path is the /api-relative path, e.g.
 * "webview/session"). Returns null if `path` is not a webview route so the caller
 * can fall through to the CIAM passthrough.
 */
export async function handleWebviewRoute(
    request: HttpRequest,
    context: InvocationContext,
    path: string
): Promise<HttpResponseInit | null> {
    if (path === "webview/session") {
        if (request.method.toUpperCase() !== "POST") {
            return { status: 405, jsonBody: { error: { message: "Method not allowed." } } };
        }
        try {
            const user = await verifyBearerToken(request);
            const email =
                [user.signin_email, user.email, user.preferred_username].find(
                    (e) => typeof e === "string" && e.includes("@")
                ) ?? null;
            const cookieValue = makeWebviewCookieValue({
                oid: user.oid as string,
                email,
                name: user.name ?? null,
            });
            return {
                status: 200,
                jsonBody: { ok: true, user: { email, name: user.name ?? null } },
                cookies: [
                    {
                        name: WEBVIEW_COOKIE_NAME,
                        value: cookieValue,
                        httpOnly: true,
                        sameSite: "Lax",
                        path: "/",
                        secure: true,
                        maxAge: WEBVIEW_SESSION_TTL_SECONDS,
                    },
                ],
            };
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 500;
            if (status === 500) context.error(error);
            const message = error instanceof Error ? error.message : "Webview session failed.";
            return { status, jsonBody: { error: { message } } };
        }
    }

    if (path === "webview/content" || path === "webview/content/profile") {
        if (request.method.toUpperCase() !== "GET") {
            return { status: 405, body: "Method not allowed." };
        }
        const session = readWebviewCookie(request);
        if (!session) {
            return {
                status: 401,
                headers: { "Content-Type": "text/html; charset=utf-8" },
                body: webviewUnauthedHtml(),
            };
        }
        return {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
            body: webviewContentHtml(session, { profile: path === "webview/content/profile" }),
        };
    }

    return null;
}
