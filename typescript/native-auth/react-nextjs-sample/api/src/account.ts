import { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import crypto from "crypto";
import { HttpError, TENANT_ID, CLIENT_ID, TokenClaims, verifyCiamToken } from "./tokenAuth";

/**
 * Account self-management for Azure Static Web Apps — the deployed-host counterpart
 * of the account routes in cors.js. Change the signed-in user's sign-in email or
 * mobile MFA number against Microsoft Graph.
 *
 * The Graph APIs behind these need an APP-ONLY token (no delegated self-service
 * permission exists for external-tenant customers), so the client secret and the
 * Graph token must never reach the browser. This function holds them and exposes a
 * few narrow routes:
 *
 *   GET  /api/account                       read the caller's email + mobile number
 *   POST /api/account/signin-name/send-otp  email a verification code to a NEW
 *                                           sign-in email (proves mailbox control)
 *   POST /api/account/signin-name           change sign-in email (fresh token + OTP)
 *   POST /api/account/phone                 change mobile number (fresh token)
 *
 * Every request carries the signed-in user's ID token in the custom `X-Account-Token`
 * header (NOT `Authorization`, which SWA clobbers — see webview.ts / tokenAuth.ts);
 * the Graph user id is taken from its verified `oid`, so a caller can only ever
 * manage their own account. Password changes are deliberately absent — Graph has no
 * app-only path to set a user's own password — so the account page routes those into
 * the native /reset-password flow.
 *
 * Graph app-role permissions the app registration needs (admin-consented):
 *   - User.ReadWrite.All           (read user + sync mail/otherMails)
 *   - User.ManageIdentities.All    (PATCH identities = change sign-in name)
 *   - UserAuthenticationMethod.ReadWrite.All (read + update phone/email methods)
 *
 * The OTP email goes out via Azure Communication Services; set
 * COMMUNICATION_SERVICES_CONNECTION_STRING + COMMUNICATION_SERVICES_SENDER_ADDRESS in
 * the SWA app settings. The app-only secret is ACCOUNT_CLIENT_SECRET (falls back to
 * PASSKEY_CLIENT_SECRET). Demo-grade — host the same logic in a real backend for production.
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// External ID customer sign-in identities are surfaced/managed on beta; v1.0 can
// return an empty identities[] for these accounts.
const GRAPH_BETA = "https://graph.microsoft.com/beta";
// Well-known mobile phone authentication-method id (same for every user).
const MOBILE_PHONE_METHOD_ID = "3179e48a-750b-4051-897c-87b9720928f7";

// How fresh the user's token must be for a change. Native auth has no step-up MFA,
// but the native sign-in itself included SMS MFA, so a recently-issued token means
// "MFA happened recently". When the token is older we answer mfa_required and the
// page asks the user to sign in again.
const FRESH_MFA_MAX_AGE_SECONDS = 15 * 60;

// New-email verification OTP.
const OTP_TTL_SECONDS = 10 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 30;

const ACCOUNT_CLIENT_SECRET = process.env.ACCOUNT_CLIENT_SECRET || process.env.PASSKEY_CLIENT_SECRET;
const ACS_CONNECTION_STRING = process.env.COMMUNICATION_SERVICES_CONNECTION_STRING;
const ACS_SENDER_ADDRESS = process.env.COMMUNICATION_SERVICES_SENDER_ADDRESS;
const MAIL_SENDER_DISPLAY_NAME = process.env.MAIL_SENDER_DISPLAY_NAME || "myServiceTas";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// E.164-ish: "+", country code, optional spaces. Graph wants "+{cc} {number}".
const PHONE_RE = /^\+[0-9][0-9\s]{6,17}$/;

/* ------------------------------ Graph client ------------------------------ */

let appTokenCache: { token: string; expiresAt: number } | null = null;

async function getAppToken(forceRefresh = false): Promise<string> {
    if (!ACCOUNT_CLIENT_SECRET) {
        throw new HttpError(
            500,
            "Account management is not configured. Set ACCOUNT_CLIENT_SECRET in the SWA app settings (see README, 'My account' section)."
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
    const response = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
        method: "POST",
        body,
    });
    const data = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
        error_description?: string;
    };
    if (!response.ok || !data.access_token) {
        throw new HttpError(502, data.error_description ?? "Could not acquire Graph token.");
    }
    appTokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + ((data.expires_in ?? 3600) - 300) * 1000,
    };
    return appTokenCache.token;
}

interface GraphResult {
    status: number;
    ok: boolean;
    body: string;
    // Graph payloads are deeply variable; callers read it defensively (json?.error?.message etc.).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: any;
}

async function callGraph(
    method: string,
    endpoint: string,
    body?: unknown,
    base = GRAPH_BASE
): Promise<GraphResult> {
    const attempt = async (forceFreshToken: boolean): Promise<GraphResult> => {
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
        let json: unknown;
        try {
            json = text ? JSON.parse(text) : undefined;
        } catch {
            json = undefined;
        }
        return { status: response.status, ok: response.ok, body: text, json };
    };

    let result = await attempt(false);
    if (result.status === 401 || result.status === 403) {
        // App-role grants made recently only show up in a fresh token (the cached one
        // is good for ~1h). Retry once with a new token.
        result = await attempt(true);
    }
    return result;
}

/** Throw a friendly HttpError carrying the Graph error message when a call fails. */
function assertGraphOk(result: GraphResult, fallback: string): void {
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
 * claims-challenge step-up, so this leans on `iat` age: the native sign-in included
 * SMS MFA, so a recently-issued token means MFA happened recently. CIAM tokens carry
 * no amr/auth_time to re-verify independently, so when amr is absent we trust iat
 * freshness; when present it must name a second factor.
 */
function requireFreshMfa(payload: TokenClaims): void {
    const now = Math.floor(Date.now() / 1000);
    const freshEnough = (payload.iat ?? 0) >= now - FRESH_MFA_MAX_AGE_SECONDS;
    const amrOk = !Array.isArray(payload.amr) || payload.amr.some((m) => MFA_AMR_VALUES.includes(m));

    if (!freshEnough || !amrOk) {
        throw new HttpError(
            401,
            "For your security, please sign out and sign in again, then retry this change.",
            "mfa_required"
        );
    }
}

/* --------------------------- new-email OTP store -------------------------- */

interface PendingOtp {
    email: string;
    codeHash: string;
    expiresAt: number;
    attempts: number;
    lastSentAt: number;
}

// Pending verification codes, keyed by the caller's oid. In-memory only: a function
// restart (or a different instance) drops pending codes and the user simply requests
// a new one. A single SWA function app instance handles the send + verify pair in the
// common case; under heavy scale-out a shared store (e.g. Table Storage) would be the
// production answer.
const pendingOtps = new Map<string, PendingOtp>();

const hashOtp = (code: string): string => crypto.createHash("sha256").update(code).digest("hex");

function hashesEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function generateOtp(): string {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Validate a submitted code for this oid+email and consume it on success. Throws
 * HttpError("otp_invalid"/"otp_required") otherwise. A wrong code burns an attempt;
 * exhausting attempts (or expiry) drops the entry.
 */
function verifyOtp(oid: string, email: string, code: string): void {
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
        throw new HttpError(
            400,
            "The verification code was sent to a different email. Please request a new one.",
            "otp_required"
        );
    }
    if (!/^\d{6}$/.test(code) || !hashesEqual(entry.codeHash, hashOtp(code))) {
        entry.attempts += 1;
        if (entry.attempts >= OTP_MAX_ATTEMPTS) {
            pendingOtps.delete(oid);
            throw new HttpError(
                400,
                "Too many incorrect attempts. Please request a new code and try again.",
                "otp_required"
            );
        }
        throw new HttpError(400, "That verification code is incorrect. Please try again.", "otp_invalid");
    }
    pendingOtps.delete(oid); // single-use
}

/** Generate, store, and email a verification code for a new sign-in email. */
async function sendSignInOtp(oid: string, email: string): Promise<void> {
    if (!ACS_CONNECTION_STRING || !ACS_SENDER_ADDRESS) {
        throw new HttpError(
            500,
            "Email provider not configured. Set COMMUNICATION_SERVICES_CONNECTION_STRING and COMMUNICATION_SERVICES_SENDER_ADDRESS in the SWA app settings."
        );
    }
    // Lazy-import so the function still loads (and the rest of the API works) when
    // @azure/communication-email isn't installed. Typed to just the surface we use,
    // to avoid the esm/cjs declaration clash on the EmailClient class type.
    type AcsModule = {
        EmailClient: new (connectionString: string) => {
            beginSend(message: {
                senderAddress: string;
                recipients: { to: Array<{ address: string }> };
                content: { subject: string; html: string; plainText: string };
            }): Promise<unknown>;
        };
    };
    let EmailClient: AcsModule["EmailClient"];
    try {
        ({ EmailClient } = (await import("@azure/communication-email")) as unknown as AcsModule);
    } catch {
        throw new HttpError(
            500,
            "The email package isn't installed. Run `npm install` in api/ (it adds @azure/communication-email)."
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
    } catch {
        pendingOtps.delete(oid); // no email went out — don't strand a dead code
        throw new HttpError(502, "Could not send the verification email. Please try again.");
    }
}

/**
 * Branded verification email for a new sign-in address. Mirrors the cors.js / browser-
 * delegated proxy template (table-based, inline styles for email-client compat).
 */
function buildOtpEmail(
    email: string,
    code: string,
    brandName: string
): { subject: string; html: string; plainText: string } {
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

interface GraphIdentity {
    signInType?: string;
    issuerAssignedId?: string;
    issuer?: string;
}

interface GraphUser {
    displayName?: string | null;
    identities?: GraphIdentity[];
    userPrincipalName?: string;
    mail?: string | null;
    otherMails?: string[];
}

/**
 * Get the account's real identities[]. App-only GET often returns identities: [] for
 * External ID CIAM accounts even when an emailAddress identity exists — a $filter on
 * identities bypasses that masking. Probes the profile `mail` first, then the email
 * claim from the caller's verified token, then otherMails.
 */
async function getRealIdentities(
    oid: string,
    userJson: GraphUser,
    tokenEmail: string | undefined
): Promise<GraphIdentity[]> {
    const direct = userJson?.identities ?? [];
    if (direct.some((i) => i.signInType === "emailAddress")) return direct;

    const probeEmails = [
        ...new Set(
            [userJson?.mail, tokenEmail, ...(userJson?.otherMails ?? [])].filter(
                (e): e is string => typeof e === "string" && e.includes("@")
            )
        ),
    ];
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
            const match = (probe.json?.value ?? []).find((u: { id?: string }) => u.id === oid);
            if (match?.identities?.length) return match.identities;
        }
    }
    return direct;
}

/**
 * Find the email the user actually signs in with. Returns
 * { kind: "identity", index, value } | { kind: "upn", value } | null.
 */
function resolveSignInEmail(
    userJson: GraphUser
): { kind: "identity"; index: number; value: string } | { kind: "upn"; value: string } | null {
    const identities = userJson?.identities ?? [];
    const index = identities.findIndex(
        (i) =>
            i.signInType === "emailAddress" ||
            (i.signInType === "userName" && String(i.issuerAssignedId ?? "").includes("@"))
    );
    if (index !== -1) {
        return { kind: "identity", index, value: identities[index].issuerAssignedId as string };
    }
    const upn = userJson?.userPrincipalName;
    if (upn && String(upn).includes("@")) {
        return { kind: "upn", value: upn };
    }
    return null;
}

interface AccountSummary {
    displayName: string | null;
    email: string | null;
    username: string | null;
    phoneNumber: string | null;
}

/** Read the user's current sign-in email (and username, if any) + mobile number. */
async function getAccountSummary(oid: string, tokenEmail: string | undefined): Promise<AccountSummary> {
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
    const mobile = methods.find((m: { phoneType?: string }) => m.phoneType === "mobile") ?? methods[0];

    return {
        displayName: user.json?.displayName ?? null,
        email: (signIn && "value" in signIn ? signIn.value : null) ?? user.json?.mail ?? null,
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
async function changeSignInName(
    oid: string,
    newEmail: string,
    tokenEmail: string | undefined
): Promise<{ synced: string[]; warnings: string[] }> {
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
    const warnings: string[] = [];

    // 2. Email one-time-passcode method (create one if absent so the new address is
    //    the explicit OTP target either way).
    try {
        const methods = await callGraph("GET", `/users/${oid}/authentication/emailMethods`);
        if (methods.ok) {
            const method = (methods.json?.value ?? [])[0];
            const upd = method
                ? await callGraph("PATCH", `/users/${oid}/authentication/emailMethods/${method.id}`, {
                      emailAddress: newEmail,
                  })
                : await callGraph("POST", `/users/${oid}/authentication/emailMethods`, {
                      emailAddress: newEmail,
                  });
            if (upd.ok) synced.push(method ? "email OTP method" : "email OTP method (created)");
            else warnings.push(`email OTP method: ${upd.json?.error?.message ?? `HTTP ${upd.status}`}`);
        } else {
            warnings.push(`email OTP method: ${methods.json?.error?.message ?? `HTTP ${methods.status}`}`);
        }
    } catch (err) {
        warnings.push(`email OTP method: ${err instanceof Error ? err.message : String(err)}`);
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
        warnings.push(`profile email (mail): ${err instanceof Error ? err.message : String(err)}`);
    }

    return { synced, warnings };
}

/**
 * Change the mobile MFA number. Update the existing mobile method if present;
 * otherwise create one (a phone's type can't be changed, so always target mobile).
 */
async function changePhone(oid: string, phoneNumber: string): Promise<void> {
    const existing = await callGraph("GET", `/users/${oid}/authentication/phoneMethods`);
    assertGraphOk(existing, "Could not read your current phone methods.");
    const hasMobile = (existing.json?.value ?? []).some((m: { phoneType?: string }) => m.phoneType === "mobile");

    const result = hasMobile
        ? await callGraph("PATCH", `/users/${oid}/authentication/phoneMethods/${MOBILE_PHONE_METHOD_ID}`, {
              phoneNumber,
              phoneType: "mobile",
          })
        : await callGraph("POST", `/users/${oid}/authentication/phoneMethods`, {
              phoneNumber,
              phoneType: "mobile",
          });
    assertGraphOk(result, "Could not change your phone number.");
}

/* ---------------------------- account routing ----------------------------- */

/**
 * Handle the account self-management routes (path is the /api-relative path, e.g.
 * "account" or "account/phone"). Returns null if `path` is not an account route so
 * the caller can fall through to the CIAM passthrough. Every route verifies the
 * caller's token (X-Account-Token); the two mutations additionally require a fresh one.
 */
export async function handleAccountRoute(
    request: HttpRequest,
    context: InvocationContext,
    path: string
): Promise<HttpResponseInit | null> {
    if (path !== "account" && !path.startsWith("account/")) return null;

    const method = request.method.toUpperCase();
    try {
        const user = await verifyCiamToken(request.headers.get("x-account-token"));
        const oid = user.oid as string;
        // Email claim from the verified token — a probe value when the app-only read
        // masks identities[] (see getRealIdentities).
        const tokenEmail = [user.email, user.preferred_username].find(
            (e): e is string => typeof e === "string" && e.includes("@")
        );

        if (path === "account" && method === "GET") {
            const summary = await getAccountSummary(oid, tokenEmail);
            return { status: 200, jsonBody: summary };
        }

        if (path === "account/signin-name/send-otp" && method === "POST") {
            // Emailing the code is low-risk and must precede the fresh-token gate, so
            // this only needs a valid token (the gate stays on the change itself).
            const body = (await readJson(request)) as { email?: string };
            const email = String(body.email ?? "").trim();
            if (!EMAIL_RE.test(email)) throw new HttpError(400, "Enter a valid email address.");
            await sendSignInOtp(oid, email);
            return {
                status: 200,
                jsonBody: { ok: true, message: `We've emailed a verification code to ${email}.` },
            };
        }

        if (path === "account/signin-name" && method === "POST") {
            requireFreshMfa(user);
            const body = (await readJson(request)) as { email?: string; otp?: string };
            const email = String(body.email ?? "").trim();
            if (!EMAIL_RE.test(email)) throw new HttpError(400, "Enter a valid email address.");
            verifyOtp(oid, email, String(body.otp ?? "").trim());
            const { synced, warnings } = await changeSignInName(oid, email, tokenEmail);
            let message = `Sign-in email changed to ${email} (updated: ${synced.join(", ")}). Sign out and back in to refresh your token.`;
            if (warnings.length) message += ` Note: ${warnings.join("; ")}`;
            return { status: 200, jsonBody: { ok: true, message } };
        }

        if (path === "account/phone" && method === "POST") {
            requireFreshMfa(user);
            const body = (await readJson(request)) as { phoneNumber?: string };
            const phoneNumber = String(body.phoneNumber ?? "").trim();
            if (!PHONE_RE.test(phoneNumber)) {
                throw new HttpError(
                    400,
                    "Enter a valid phone number in international format, e.g. +61 412345678."
                );
            }
            await changePhone(oid, phoneNumber);
            return { status: 200, jsonBody: { ok: true, message: `Mobile number changed to ${phoneNumber}.` } };
        }

        return { status: 404, jsonBody: { error: { message: "Not found." } } };
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) context.error(error);
        const message = error instanceof Error ? error.message : "Account request failed.";
        const code = error instanceof HttpError ? error.code : undefined;
        return { status, jsonBody: { error: { message, code } } };
    }
}

async function readJson(request: HttpRequest): Promise<Record<string, unknown>> {
    try {
        return ((await request.json()) as Record<string, unknown>) ?? {};
    } catch {
        throw new HttpError(400, "Invalid JSON body.");
    }
}
