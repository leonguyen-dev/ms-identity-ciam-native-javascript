/**
 * Local Graph proxy for the browser-delegated sample — run with `npm run proxy`.
 *
 * Backs the two self-service pages (Security/passkeys and My account) against
 * Microsoft Graph. Both feature sets hit Graph APIs that require an APP-ONLY
 * token (there is no delegated/self-service permission for external-tenant
 * customers), so the client secret and the Graph token must never reach the
 * browser. This one server keeps them here and exposes a few narrow endpoints to
 * the SPA, split across two disjoint route namespaces:
 *
 *   Passkeys (FIDO2) — fido2Methods provisioning:
 *     GET    /api/passkeys                   list the caller's passkeys
 *     GET    /api/passkeys/creation-options  WebAuthn creationOptions  (fresh MFA)
 *     POST   /api/passkeys                   register a credential     (fresh MFA)
 *     DELETE /api/passkeys/{id}              delete a passkey          (fresh MFA)
 *
 *   Account self-management:
 *     GET  /api/account                       read the caller's email + mobile number
 *     POST /api/account/signin-name/send-otp  email a verification code to a NEW
 *                                             sign-in email (proves mailbox control)
 *     POST /api/account/signin-name           change sign-in email (fresh MFA + OTP)
 *     POST /api/account/phone                 change mobile number (fresh MFA)
 *
 * (Previously two separate servers — passkey-proxy.mjs and account-proxy.mjs —
 * that both bound port 3001, so only one could run at a time. They share the same
 * token-verification + app-only-Graph machinery and their routes never overlap,
 * so they are merged here.)
 *
 * New-email verification: Microsoft Graph has no app-only API to send + verify a
 * one-time code to an arbitrary address, so the proxy mints its own. send-otp
 * generates a 6-digit code, emails it to the requested address via Azure
 * Communication Services (the same transport the native-auth otp-email-function
 * uses), and stashes a hash keyed by the caller's oid. The signin-name change
 * then requires that code back, so a user can only set their sign-in email to a
 * mailbox they actually control. The fresh-MFA gate (ngcmfa) still applies to the
 * change itself — OTP proves mailbox control, MFA proves it's really you.
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
 *   - UserAuthMethod-Passkey.ReadWrite.All  (list/register/delete fido2Methods)
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
import { EmailClient } from "@azure/communication-email";

const PORT = 3001;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// External ID customer-account sign-in identities are surfaced/managed on beta;
// v1.0 can return an empty identities[] for these accounts. fido2Methods
// provisioning also lives on beta.
const GRAPH_BETA = "https://graph.microsoft.com/beta";

// Well-known authentication-method ids (the same constants for every user).
// https://learn.microsoft.com/graph/api/phoneauthenticationmethod-update
const MOBILE_PHONE_METHOD_ID = "3179e48a-750b-4051-897c-87b9720928f7";

// Challenge lifetime baked into the passkey creationOptions Graph hands back.
const CHALLENGE_TIMEOUT_MINUTES = 60;

// How fresh the user's token must be for a change (ngcmfa tokens are issued at
// MFA time, so iat age ≈ time since MFA).
const FRESH_MFA_MAX_AGE_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;

// New-email verification OTP. The TTL is generous enough to survive the MFA
// redirect detour the change endpoint triggers (the pending code is held while
// the browser bounces through the hosted MFA page and back).
const OTP_TTL_SECONDS = 10 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 30;

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

// One app registration backs both feature sets, so either secret name works.
// (PASSKEY_CLIENT_SECRET is kept for back-compat with older .env.local files.)
const CLIENT_SECRET = process.env.ACCOUNT_CLIENT_SECRET ?? process.env.PASSKEY_CLIENT_SECRET;
if (!CLIENT_SECRET) {
    console.error(
        "ACCOUNT_CLIENT_SECRET is not set. Add it to .env.local (see README, 'My account' / 'Passkeys' sections)."
    );
    process.exit(1);
}

// Azure Communication Services email — the transport for the new-email
// verification OTP. Reuse the same connection string + sender the native-auth
// otp-email-function uses (see typescript/native-auth/otp-email-function). When
// unset, the send-otp endpoint fails with a clear message rather than silently.
const ACS_CONNECTION_STRING = process.env.COMMUNICATION_SERVICES_CONNECTION_STRING;
const ACS_SENDER_ADDRESS = process.env.COMMUNICATION_SERVICES_SENDER_ADDRESS;
const MAIL_SENDER_DISPLAY_NAME = process.env.MAIL_SENDER_DISPLAY_NAME || "myServiceTas";

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

/* --------------------------- new-email OTP store -------------------------- */

// Pending verification codes, keyed by the caller's oid. In-memory only: a proxy
// restart drops pending codes and the user simply requests a new one. Each entry
// binds the code to a specific new email, so changing the email field after
// sending forces a fresh send.
const pendingOtps = new Map(); // oid -> { email, codeHash, expiresAt, attempts, lastSentAt }

const hashOtp = (code) => crypto.createHash("sha256").update(code).digest("hex");

// Constant-time compare of two hex digests (equal length here, but guard anyway).
function hashesEqual(a, b) {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function generateOtp() {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Validate a submitted code for this oid+email and consume it on success. Returns
 * nothing on success; throws HttpError("otp_invalid"/"otp_required") otherwise.
 * A wrong code burns an attempt; exhausting attempts (or expiry) drops the entry.
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
        // The code was issued for a different address than the one being saved.
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
        // beginSend resolving means ACS accepted the message; we don't poll for
        // delivery (it's routinely several seconds).
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
 * Branded verification email for a new sign-in address. Mirrors the native-auth
 * otp-email-function's emailTemplate (kept inline here because that TS module
 * isn't importable from this standalone .mjs proxy). Table-based with inline
 * styles for email-client compatibility.
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

/* --------------------------- passkey operations --------------------------- */

/** Graph collection holding the caller's FIDO2/passkey methods. */
const fido2MethodsPath = (oid) => `/users/${oid}/authentication/fido2Methods`;

/* --------------------------- account operations --------------------------- */

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

// Pin CORS to known dev origins rather than `*` — this proxy wields app-only
// Graph permissions, so don't let arbitrary pages in the browser talk to it.
// Two origins are in play: the account page runs on plain localhost, while the
// passkey page is served from the auth.<tenant>.ciamlogin.com host (the WebAuthn
// rp.id requires it). Reflect whichever allowlisted origin made the request.
const ALLOWED_ORIGINS = new Set(
    (
        process.env.PROXY_ALLOWED_ORIGINS ??
        `http://localhost:3000,https://auth.${TENANT_SUBDOMAIN}.ciamlogin.com:3000`
    )
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
);

function corsHeadersFor(req) {
    const origin = req.headers.origin;
    // Reflect the caller's origin only when it's allowlisted; otherwise fall back
    // to the first allowed origin (a non-match the browser will simply block).
    const allowOrigin =
        origin && ALLOWED_ORIGINS.has(origin) ? origin : [...ALLOWED_ORIGINS][0];
    return {
        "Access-Control-Allow-Origin": allowOrigin,
        Vary: "Origin",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
    };
}

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

http.createServer(async (req, res) => {
    const corsHeaders = corsHeadersFor(req);

    if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const route = `${req.method} ${url.pathname}`;
    console.log(`-> ${route}`);

    try {
        const user = await verifyUserToken(req);
        const oid = user.oid;

        /* ---------------------------- passkeys ---------------------------- */
        if (url.pathname === "/api/passkeys" || url.pathname.startsWith("/api/passkeys/")) {
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
                    {
                        displayName: body.displayName,
                        publicKeyCredential: body.publicKeyCredential,
                    },
                    GRAPH_BETA
                );
                sendJson(res, result.status, result.body, corsHeaders);
            } else if (req.method === "DELETE" && url.pathname.startsWith("/api/passkeys/")) {
                requireFreshMfa(user);
                const passkeyId = decodeURIComponent(url.pathname.slice("/api/passkeys/".length));
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

        /* ----------------------------- account ---------------------------- */
        // Email claim from the verified token — used as a probe value when the
        // app-only read masks identities[] (see getRealIdentities).
        const tokenEmail = [user.email, user.preferred_username].find(
            (e) => typeof e === "string" && e.includes("@")
        );

        if (route === "GET /api/account") {
            const summary = await getAccountSummary(oid, tokenEmail);
            sendJson(res, 200, summary, corsHeaders);
        } else if (route === "POST /api/account/signin-name/send-otp") {
            // Emailing a code to the prospective address is low-risk and must
            // happen before the user has fresh MFA, so this only needs a valid
            // token (the fresh-MFA gate stays on the change itself).
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
        } else if (route === "POST /api/account/signin-name") {
            requireFreshMfa(user);
            const body = await parseJsonBody(req);
            const email = String(body.email ?? "").trim();
            if (!EMAIL_RE.test(email)) {
                throw new HttpError(400, "Enter a valid email address.");
            }
            // Consume the verification code proving the user controls the new
            // mailbox before any Graph write happens.
            verifyOtp(oid, email, String(body.otp ?? "").trim());
            const { synced, warnings } = await changeSignInName(oid, email, tokenEmail);
            let message = `Sign-in email changed to ${email} (updated: ${synced.join(", ")}). Sign out and back in to refresh your token.`;
            if (warnings.length) {
                message += ` Note: ${warnings.join("; ")}`;
            }
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
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error(error);
        sendJson(res, status, { error: { message: error.message, code: error.code } }, corsHeaders);
    }
    // Loopback only — never expose an app-only Graph credential to the LAN.
}).listen(PORT, "127.0.0.1", () => {
    console.log(`Local Graph proxy listening on http://localhost:${PORT}`);
    console.log(`  passkeys: /api/passkeys   account: /api/account`);
    console.log(`  CORS origins: ${[...ALLOWED_ORIGINS].join(", ")}`);
    console.log(`Graph user scope: tenant ${TENANT_SUBDOMAIN} (${TENANT_ID})`);
});
