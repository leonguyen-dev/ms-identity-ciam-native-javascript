/**
 * Local account self-management proxy — run with `npm run account-proxy`.
 *
 * Backs the /account page's three operations against Microsoft Graph. Each one
 * requires an APP-ONLY token (there is no delegated/self-service permission for
 * external-tenant customers), so the client secret and the Graph token must
 * never reach the browser. This little server keeps them here and exposes four
 * narrow endpoints to the SPA:
 *
 *   GET  /api/account               read the caller's email + mobile number
 *   POST /api/account/signin-name   change sign-in email (fresh MFA)
 *   POST /api/account/phone         change mobile number (fresh MFA)
 *
 * Password changes are deliberately NOT here. Microsoft Graph's resetPassword
 * API does not support application permissions (and can't act on a user's own
 * account), and External ID exposes no delegated self-service password
 * permission for customers — so there is no Graph path to it. The account page
 * routes password changes into the Entra-hosted SSPR ("Forgot password?") flow.
 *
 * Every request must carry the signed-in user's ID token as a Bearer token. It
 * is verified against the tenant's JWKS (signature, issuer, audience, tenant,
 * expiry) and the Graph user id is taken from its `oid` claim — so a caller can
 * only ever manage their own account. MFA freshness for the mutating endpoints
 * is enforced by the SPA's `ngcmfa` claims challenge — Entra won't issue that
 * token silently without recent MFA, forcing an interactive redirect. The proxy
 * backstops it by requiring a freshly-issued token (CIAM tokens carry no
 * amr/auth_time claim for the proxy to re-verify MFA from independently).
 *
 * Graph app-role permissions the app registration needs (admin-consented):
 *   - User.ReadWrite.All                  (read user + sync mail/otherMails after a
 *                                          sign-in email change — that profile email
 *                                          is where Entra sends OTP verification codes)
 *   - User.ManageIdentities.All           (PATCH identities = change sign-in name;
 *                                          User.ReadWrite.All is NOT sufficient for
 *                                          the identities property specifically)
 *   - UserAuthenticationMethod.ReadWrite.All  (read + update phone/email methods)
 *
 * Local/demo use only. For production, host the same logic in a real backend
 * (e.g. an Azure Function behind the Static Web App) and store the secret in
 * Key Vault.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";

const PORT = 3001;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// External ID customer-account sign-in identities are surfaced/managed on beta;
// v1.0 can return an empty identities[] for these accounts.
const GRAPH_BETA = "https://graph.microsoft.com/beta";

// Well-known authentication-method ids (the same constants for every user).
// https://learn.microsoft.com/graph/api/phoneauthenticationmethod-update
const MOBILE_PHONE_METHOD_ID = "3179e48a-750b-4051-897c-87b9720928f7";

// How fresh the user's token must be for a change (ngcmfa tokens are issued at
// MFA time, so iat age ≈ time since MFA).
const FRESH_MFA_MAX_AGE_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;

/* ----------------------------- configuration ------------------------------ */

// Minimal .env.local loader so the secret stays out of the repo (gitignored).
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
            // Unquoted: strip inline comments and any trailing whitespace — a
            // secret pasted with a stray trailing space otherwise fails the
            // client-credentials flow with an opaque AADSTS7000215.
            value = value.replace(/\s+#.*$/, "").trim();
        }
        process.env[match[1]] = value;
    }
}
loadEnvLocal();

// Tenant/app coordinates — these MUST match src/config/auth-config.ts (the
// proxy rejects tokens whose aud/tid differ). If you retarget the sample,
// either update both files or override these in .env.local.
const TENANT_SUBDOMAIN = process.env.ACCOUNT_TENANT_SUBDOMAIN ?? "myservicetasdevpoc";
const TENANT_ID = process.env.ACCOUNT_TENANT_ID ?? "a67366e7-9873-4a38-9bae-0a4a18952688";
const CLIENT_ID = process.env.ACCOUNT_CLIENT_ID ?? "5f0a52ca-f5db-4a6d-9b3a-3180d51fdd08";

const CLIENT_SECRET = process.env.ACCOUNT_CLIENT_SECRET;
if (!CLIENT_SECRET) {
    console.error(
        "ACCOUNT_CLIENT_SECRET is not set. Add it to .env.local (see README, 'My account' section)."
    );
    process.exit(1);
}

/* ------------------------- user token verification ------------------------ */

let oidcMetadata = null; // { issuer, jwksUri, keys, fetchedAt }

async function getOidcMetadata(forceKeyRefresh = false) {
    const oneHour = 60 * 60 * 1000;
    if (oidcMetadata && !forceKeyRefresh && Date.now() - oidcMetadata.fetchedAt < oneHour) {
        return oidcMetadata;
    }
    const configUrl = `https://${TENANT_SUBDOMAIN}.ciamlogin.com/${TENANT_ID}/v2.0/.well-known/openid-configuration`;
    // Throw (rather than cache garbage for an hour) when the IdP answers with an
    // error — a throttling/error body parses as JSON just fine otherwise.
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
    oidcMetadata = {
        issuer: config.issuer,
        jwksUri: config.jwks_uri,
        keys: jwks.keys ?? [],
        fetchedAt: Date.now(),
    };
    return oidcMetadata;
}

class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code; // machine-readable hint for the SPA (e.g. "mfa_required")
    }
}

async function verifyUserToken(req) {
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

// amr values that indicate a second factor (the docs' "Supported amr claims"
// list, plus the ngcmfa/mfa markers). Only consulted when a token actually
// carries amr — Entra External ID CIAM tokens usually don't (see below).
const MFA_AMR_VALUES = [
    "ngcmfa", "mfa", "otp", "sms", "tel", "fido",
    "face", "fpt", "iris", "retina", "sc", "pop", "hwk",
];

function requireFreshMfa(payload) {
    const now = Math.floor(Date.now() / 1000);
    const freshEnough = (payload.iat ?? 0) >= now - FRESH_MFA_MAX_AGE_SECONDS;

    // What actually enforces MFA is the SPA's `ngcmfa` claims challenge: Entra
    // refuses to issue this token silently unless the user completed MFA
    // recently, forcing an interactive redirect. The proxy can only backstop
    // that — and Entra External ID's CIAM tokens carry NO amr / auth_time / acr
    // claim to independently re-verify it from (confirmed empirically on this
    // tenant). So:
    //   - amr absent (the normal CIAM case): rely on iat freshness + the
    //     client-side challenge having forced MFA at issuance.
    //   - amr present: it must name a second factor, otherwise we can prove the
    //     token did NOT go through MFA and reject it. (Defense in depth, in case
    //     an optional-claims config later starts emitting amr.)
    const amrOk =
        !Array.isArray(payload.amr) ||
        payload.amr.some((m) => MFA_AMR_VALUES.includes(m));

    if (!freshEnough || !amrOk) {
        throw new HttpError(
            401,
            "Recent multi-factor authentication required. Re-authenticate and try again.",
            "mfa_required"
        );
    }
}

/* ------------------------------ Graph client ------------------------------ */

let appTokenCache = null; // { token, expiresAt }

async function getAppToken(forceRefresh = false) {
    if (!forceRefresh && appTokenCache && Date.now() < appTokenCache.expiresAt) {
        return appTokenCache.token;
    }
    const body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
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
        // token — the cached one is good for ~1h. Retry once with a new token.
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

/* ------------------------------ operations -------------------------------- */

const USER_SELECT = "displayName,identities,userPrincipalName,mail,otherMails";

/**
 * Find the email the user actually signs in with. Two account models exist:
 *  - Local consumer account: an entry in identities[] with signInType
 *    "emailAddress" (or a "userName" entry holding an email).
 *  - UPN-based account: no email identity; the email *is* the userPrincipalName
 *    (this is what shows up as `upn` in the ID token).
 * Returns { kind: "identity", index } | { kind: "upn" } | null and the value.
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

/** Read the user's current sign-in email (and username, if any) + mobile number. */
async function getAccountSummary(oid, tokenEmail) {
    // The two reads are independent — issue them concurrently.
    const [user, phones] = await Promise.all([
        callGraph("GET", `/users/${oid}?$select=${USER_SELECT}`, undefined, GRAPH_BETA),
        callGraph("GET", `/users/${oid}/authentication/phoneMethods`),
    ]);
    assertGraphOk(user, "Could not read your account details.");
    assertGraphOk(phones, "Could not read your phone number.");

    // Use the unmasked identities so the summary reflects the real sign-in email
    // (the direct read can be masked, and `mail` may be stale if a previous
    // change's best-effort mail sync failed).
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
 * Get the account's real identities[]. App-only GET often returns identities: []
 * for External ID CIAM accounts even when an emailAddress identity exists —
 * $select masks it. A $filter on identities is evaluated against the real value
 * and bypasses that masking, so when the direct read looks empty we re-fetch via
 * a $filter probe. Probes try the profile `mail` first, then the email claim
 * from the caller's verified ID token, then otherMails — `mail` is often null
 * until this proxy's own mail sync has run once, so the token claim is what
 * rescues fresh sign-ups.
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
        console.log(`  identities $filter probe -> ${probe.status}`);
        if (probe.ok) {
            const match = (probe.json?.value ?? []).find((u) => u.id === oid);
            if (match?.identities?.length) return match.identities;
        }
    }
    return direct;
}

/**
 * Change the sign-in email "everywhere relevant". The sign-in identity is the
 * primary target (failure here aborts); the email OTP method and the mail/
 * otherMails profile fields are synced best-effort so the verification email and
 * the token's email claim line up. Returns { synced, warnings } for the caller
 * to report. NOTE: the literal userPrincipalName stays a *.onmicrosoft.com GUID
 * — it can't become an unverified-domain email, so it is intentionally untouched.
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

    // 2. Email one-time-passcode method. Most External ID local accounts have no
    //    registered emailAuthenticationMethod (the OTP target then falls back to
    //    the profile email, synced in step 3) — create one so the new address is
    //    the explicit OTP target either way.
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
    //    Needs User.ReadWrite.All or User-Mail.ReadWrite.All (separate from the
    //    identities permission), so this can fail with a clear hint.
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
 * otherwise create one. A phone's type can't be changed, so we always target
 * the mobile slot.
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

/* ------------------------------ validation -------------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// E.164-ish: "+", country code, optional spaces. Graph wants "+{cc} {number}".
const PHONE_RE = /^\+[0-9][0-9\s]{6,17}$/;

/* -------------------------------- server ---------------------------------- */

// Pin CORS to the dev SPA rather than `*` — this proxy wields app-only Graph
// permissions, so don't let arbitrary pages in the browser talk to it.
const SPA_ORIGIN = process.env.ACCOUNT_ALLOWED_ORIGIN ?? "http://localhost:3000";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": SPA_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
};

function sendJson(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
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

http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const route = `${req.method} ${url.pathname}`;
    console.log(`-> ${route}`);

    try {
        const user = await verifyUserToken(req);
        const oid = user.oid;

        // Email claim from the verified token — used as a probe value when the
        // app-only read masks identities[] (see getRealIdentities).
        const tokenEmail = [user.email, user.preferred_username].find(
            (e) => typeof e === "string" && e.includes("@")
        );

        if (route === "GET /api/account") {
            const summary = await getAccountSummary(oid, tokenEmail);
            sendJson(res, 200, summary);
        } else if (route === "POST /api/account/signin-name") {
            requireFreshMfa(user);
            const body = await parseJsonBody(req);
            const email = String(body.email ?? "").trim();
            if (!EMAIL_RE.test(email)) {
                throw new HttpError(400, "Enter a valid email address.");
            }
            const { synced, warnings } = await changeSignInName(oid, email, tokenEmail);
            let message = `Sign-in email changed to ${email} (updated: ${synced.join(", ")}). Sign out and back in to refresh your token.`;
            if (warnings.length) {
                message += ` Note: ${warnings.join("; ")}`;
            }
            sendJson(res, 200, { ok: true, message });
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
            sendJson(res, 200, { ok: true, message: `Mobile number changed to ${phoneNumber}.` });
        } else {
            throw new HttpError(404, "Not found.");
        }
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error(error);
        sendJson(res, status, { error: { message: error.message, code: error.code } });
    }
    // Loopback only — never expose an app-only Graph credential to the LAN.
}).listen(PORT, "127.0.0.1", () => {
    console.log(`Account proxy listening on http://localhost:${PORT} (CORS origin: ${SPA_ORIGIN})`);
    console.log(`Graph user scope: tenant ${TENANT_SUBDOMAIN} (${TENANT_ID})`);
});
