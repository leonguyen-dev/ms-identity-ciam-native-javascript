/**
 * Local passkey (FIDO2) management proxy — run with `npm run passkey-proxy`.
 *
 * The Microsoft Graph fido2Methods provisioning APIs require an APP-ONLY token
 * (application permission `UserAuthMethod-Passkey.ReadWrite.All`); there is no
 * delegated/self-service permission for external-tenant customers yet. The
 * client secret and the Graph token must never reach the browser, so this
 * little server keeps them here and exposes four narrow endpoints to the SPA:
 *
 *   GET    /api/passkeys                   list the caller's passkeys
 *   GET    /api/passkeys/creation-options  WebAuthn creationOptions  (fresh MFA)
 *   POST   /api/passkeys                   register a credential     (fresh MFA)
 *   DELETE /api/passkeys/{id}              delete a passkey          (fresh MFA)
 *
 * Every request must carry the signed-in user's ID token as a Bearer token. It
 * is verified against the tenant's JWKS (signature, issuer, audience, tenant,
 * expiry) and the Graph user id is taken from its `oid` claim — so a caller can
 * only ever manage their own passkeys. Mutating endpoints additionally require
 * the token to be freshly issued (the SPA requests it with an `ngcmfa` claims
 * challenge, so a fresh `iat` implies recent MFA).
 *
 * Local/demo use only. For production, host the same logic in a real backend
 * (e.g. an Azure Function behind the Static Web App) and store the secret in
 * Key Vault.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";

const TENANT_SUBDOMAIN = "myservicetasdevpoc";
const TENANT_ID = "a67366e7-9873-4a38-9bae-0a4a18952688";
const CLIENT_ID = "5f0a52ca-f5db-4a6d-9b3a-3180d51fdd08";

const PORT = 3001;
const GRAPH_BASE = "https://graph.microsoft.com/beta";
// Challenge lifetime baked into the creationOptions Graph hands back.
const CHALLENGE_TIMEOUT_MINUTES = 60;
// How fresh the user's token must be for add/delete (ngcmfa tokens are issued
// at MFA time, so iat age ≈ time since MFA).
const FRESH_MFA_MAX_AGE_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;

/* ----------------------------- configuration ------------------------------ */

// Minimal .env.local loader so the secret stays out of the repo (gitignored).
function loadEnvLocal() {
    const envPath = path.join(process.cwd(), ".env.local");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (match && !(match[1] in process.env)) {
            process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
        }
    }
}
loadEnvLocal();

const CLIENT_SECRET = process.env.PASSKEY_CLIENT_SECRET;
if (!CLIENT_SECRET) {
    console.error(
        "PASSKEY_CLIENT_SECRET is not set. Add it to .env.local (see README, Passkeys section)."
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
    const config = await (await fetch(configUrl)).json();
    const jwks = await (await fetch(config.jwks_uri)).json();
    oidcMetadata = {
        issuer: config.issuer,
        jwksUri: config.jwks_uri,
        keys: jwks.keys ?? [],
        fetchedAt: Date.now(),
    };
    return oidcMetadata;
}

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
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

function requireFreshMfa(payload) {
    const now = Math.floor(Date.now() / 1000);
    const freshEnough = (payload.iat ?? 0) >= now - FRESH_MFA_MAX_AGE_SECONDS;
    // The SPA requests this token with an ngcmfa claims challenge, so when amr
    // is present it should record the MFA. iat freshness is the backstop either
    // way (v2.0 tokens don't always emit amr).
    const amrOk = !Array.isArray(payload.amr) || payload.amr.includes("ngcmfa");
    if (!freshEnough || !amrOk) {
        throw new HttpError(
            401,
            "Recent multi-factor authentication required. Re-authenticate and try again."
        );
    }
}

/* ------------------------------ Graph client ------------------------------ */

let appTokenCache = null; // { token, expiresAt }

async function getAppToken() {
    if (appTokenCache && Date.now() < appTokenCache.expiresAt) {
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

async function callGraph(method, endpoint, body) {
    const token = await getAppToken();
    const response = await fetch(`${GRAPH_BASE}${endpoint}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text };
}

/* -------------------------------- server ---------------------------------- */

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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
        const userPath = `/users/${user.oid}/authentication/fido2Methods`;

        if (route === "GET /api/passkeys") {
            const result = await callGraph("GET", userPath);
            sendJson(res, result.status, result.body);
        } else if (route === "GET /api/passkeys/creation-options") {
            requireFreshMfa(user);
            const result = await callGraph(
                "GET",
                `${userPath}/creationOptions(challengeTimeoutInMinutes=${CHALLENGE_TIMEOUT_MINUTES})`
            );
            sendJson(res, result.status, result.body);
        } else if (route === "POST /api/passkeys") {
            requireFreshMfa(user);
            const body = JSON.parse((await readBody(req)) || "{}");
            if (!body.publicKeyCredential || !body.displayName) {
                throw new HttpError(400, "Expected { displayName, publicKeyCredential }.");
            }
            const result = await callGraph("POST", userPath, {
                displayName: body.displayName,
                publicKeyCredential: body.publicKeyCredential,
            });
            sendJson(res, result.status, result.body);
        } else if (req.method === "DELETE" && url.pathname.startsWith("/api/passkeys/")) {
            requireFreshMfa(user);
            const passkeyId = decodeURIComponent(url.pathname.slice("/api/passkeys/".length));
            if (!/^[A-Za-z0-9_-]+$/.test(passkeyId)) {
                throw new HttpError(400, "Invalid passkey id.");
            }
            const result = await callGraph("DELETE", `${userPath}/${passkeyId}`);
            sendJson(res, result.status, result.body || "{}");
        } else {
            throw new HttpError(404, "Not found.");
        }
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error(error);
        sendJson(res, status, { error: { message: error.message } });
    }
}).listen(PORT, () => {
    console.log(`Passkey proxy listening on http://localhost:${PORT}`);
    console.log(`Graph user scope: tenant ${TENANT_SUBDOMAIN} (${TENANT_ID})`);
});
