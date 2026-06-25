import { accountApiBase } from "@/config/auth-config";

/**
 * Client for the account self-management routes on the local proxy (cors.js in
 * dev; the SWA managed function in production). The proxy fronts the Microsoft
 * Graph APIs that change a sign-in email or a mobile authentication method — both
 * need an app-only token, so the secret and Graph token stay server-side.
 *
 *   summary       GET  /api/account                       read current email + mobile
 *   sendSignInOtp POST /api/account/signin-name/send-otp  email a code to a new sign-in email
 *   signInName    POST /api/account/signin-name           change sign-in email (needs that code)
 *   phone         POST /api/account/phone                 change mobile number
 *
 * Password changes are NOT here: Microsoft Graph has no app-only (or external-
 * tenant self-service) path to set a user's own password, so the account page
 * routes password changes into the native self-service password reset flow
 * (/reset-password).
 *
 * Every call is authenticated with the signed-in user's ID token (from the
 * custom-auth SDK's accountData.getIdToken()); the proxy verifies it and derives
 * the Graph user id from its `oid`, so callers can only touch their own account.
 *
 * MFA note (differs from the browser-delegated sample): native auth has no
 * step-up / claims-challenge mechanism, so the two mutations rely on the proxy's
 * `iat`-freshness gate — the native sign-in already included SMS MFA, so a
 * recently-issued token passes. When the token is too old the proxy answers
 * `mfa_required` and the page asks the user to sign in again.
 */

export interface AccountSummary {
    displayName: string | null;
    email: string | null;
    username: string | null;
    phoneNumber: string | null;
}

/** Error from the proxy, carrying its machine-readable code (e.g. "mfa_required"). */
export class AccountApiError extends Error {
    constructor(message: string, public readonly code?: string) {
        super(message);
        this.name = "AccountApiError";
    }
}

async function callAccountApi(
    path: string,
    bearerToken: string,
    init: RequestInit = {}
): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(`${accountApiBase}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                // The CIAM token rides a custom header, NOT Authorization: on Azure
                // Static Web Apps the platform overwrites Authorization with its own
                // token before the request reaches the managed function, so a bearer
                // placed there never survives. The dev proxy (cors.js) reads this
                // header too. (See reference_swa_authorization_header_clobber.)
                "X-Account-Token": bearerToken,
                ...init.headers,
            },
        });
    } catch {
        throw new Error(
            "Could not reach the local proxy. Start it with `npm run cors` (see README, 'My account' section)."
        );
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        body = undefined;
    }

    if (!response.ok) {
        const err = body as { error?: { message?: string; code?: string } } | undefined;
        throw new AccountApiError(
            err?.error?.message ?? err?.error?.code ?? `HTTP ${response.status}`,
            err?.error?.code
        );
    }
    return body;
}

export async function fetchAccountSummary(bearerToken: string): Promise<AccountSummary> {
    return (await callAccountApi("/account", bearerToken)) as AccountSummary;
}

/**
 * Email a verification code to a prospective new sign-in address. Proves the
 * user controls the mailbox before changeSignInName() will accept it. Only needs
 * a valid token (not a fresh-MFA one). Returns the proxy's confirmation message.
 */
export async function sendSignInNameOtp(bearerToken: string, email: string): Promise<string> {
    const body = (await callAccountApi("/account/signin-name/send-otp", bearerToken, {
        method: "POST",
        body: JSON.stringify({ email }),
    })) as { message?: string };
    return body.message ?? "Verification code sent.";
}

/**
 * Change the sign-in email. Requires the `otp` emailed by sendSignInNameOtp()
 * and a recently-issued `bearerToken`. Returns the human-readable confirmation message.
 */
export async function changeSignInName(
    bearerToken: string,
    email: string,
    otp: string
): Promise<string> {
    const body = (await callAccountApi("/account/signin-name", bearerToken, {
        method: "POST",
        body: JSON.stringify({ email, otp }),
    })) as { message?: string };
    return body.message ?? "Sign-in email changed.";
}

export async function changePhone(bearerToken: string, phoneNumber: string): Promise<string> {
    const body = (await callAccountApi("/account/phone", bearerToken, {
        method: "POST",
        body: JSON.stringify({ phoneNumber }),
    })) as { message?: string };
    return body.message ?? "Mobile number changed.";
}
