import { accountApiBase } from "@/config/auth-config";

/**
 * Client for the local account proxy (account-proxy.mjs). The proxy fronts the
 * Microsoft Graph APIs that change a password, a sign-in email, or a mobile
 * authentication method — all of which need an app-only token, so the secret
 * and Graph token stay server-side.
 *
 *   summary    GET  /api/account               read current email + mobile
 *   signInName POST /api/account/signin-name   change sign-in email
 *   phone      POST /api/account/phone         change mobile number
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
                Authorization: `Bearer ${bearerToken}`,
                ...init.headers,
            },
        });
    } catch {
        throw new Error(
            "Could not reach the account proxy. Start it with `npm run account-proxy` (see README, 'My account' section)."
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
        throw new Error(err?.error?.message ?? err?.error?.code ?? `HTTP ${response.status}`);
    }
    return body;
}

export async function fetchAccountSummary(bearerToken: string): Promise<AccountSummary> {
    return (await callAccountApi("/account", bearerToken)) as AccountSummary;
}

/** Returns the human-readable confirmation message from the proxy. */
export async function changeSignInName(bearerToken: string, email: string): Promise<string> {
    const body = (await callAccountApi("/account/signin-name", bearerToken, {
        method: "POST",
        body: JSON.stringify({ email }),
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
