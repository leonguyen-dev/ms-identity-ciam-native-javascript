import { accountApiBase } from "@/config/auth-config";

/**
 * Client for the local proxy's account routes (local-proxy.mjs). The proxy fronts the
 * Microsoft Graph APIs that change a password, a sign-in email, or a mobile
 * authentication method — all of which need an app-only token, so the secret
 * and Graph token stay server-side.
 *
 *   summary       GET  /api/account                       read current email + mobile
 *   sendSignInOtp POST /api/account/signin-name/send-otp  email a code to a new sign-in email
 *   signInName    POST /api/account/signin-name           change sign-in email (needs that code)
 *   sendPhoneOtp  POST /api/account/phone/send-otp        SMS a code to a new mobile number
 *   phone         POST /api/account/phone                 change mobile number (needs that code)
 *
 * Password changes are NOT here: Microsoft Graph has no app-only (or external-
 * tenant self-service) path to set a user's own password, so the account page
 * routes password changes into the Entra-hosted SSPR ("Forgot password?") flow.
 *
 * Every call is authenticated with the signed-in user's ID token; the proxy
 * verifies it and derives the Graph user id from it, so callers can only touch
 * their own account. The three mutations additionally need a fresh-MFA token.
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
        response = await fetch(`${accountApiBase()}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${bearerToken}`,
                ...init.headers,
            },
        });
    } catch {
        throw new Error(
            "Could not reach the local proxy. Start it with `npm run proxy` (see README, 'My account' section)."
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
 * and a fresh-MFA `bearerToken`. Returns the human-readable confirmation message.
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

/**
 * SMS a verification code to a prospective new mobile number. Proves the user
 * controls the handset before changePhone() will accept it. Only needs a valid
 * token (not a fresh-MFA one). Returns the proxy's confirmation message.
 */
export async function sendPhoneOtp(bearerToken: string, phoneNumber: string): Promise<string> {
    const body = (await callAccountApi("/account/phone/send-otp", bearerToken, {
        method: "POST",
        body: JSON.stringify({ phoneNumber }),
    })) as { message?: string };
    return body.message ?? "Verification code sent.";
}

/**
 * Change the mobile MFA number. Requires the `otp` texted by sendPhoneOtp() and
 * a fresh-MFA `bearerToken`. Returns the human-readable confirmation message.
 */
export async function changePhone(
    bearerToken: string,
    phoneNumber: string,
    otp: string
): Promise<string> {
    const body = (await callAccountApi("/account/phone", bearerToken, {
        method: "POST",
        body: JSON.stringify({ phoneNumber, otp }),
    })) as { message?: string };
    return body.message ?? "Mobile number changed.";
}
