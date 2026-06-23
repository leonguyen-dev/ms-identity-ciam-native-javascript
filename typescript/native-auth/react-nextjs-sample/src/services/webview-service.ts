import { webviewProxyBase } from "@/config/auth-config";

/**
 * Client for the webview SSO routes on the local proxy (cors.js), Feature B / B2
 * — native app → in-app web content (embedded webview).
 *
 * A native app injects `Authorization: Bearer <token>` directly onto the
 * webview's first request (a WebView/WKWebView can set request headers). A
 * browser can't set a header on an `<iframe>` navigation, so the native-app
 * shell (app/webview/page.tsx) does the injection here with a credentialed
 * fetch: it POSTs the signed-in user's token to `/api/webview/session`, the proxy
 * validates iss/aud/tid/sig/exp and responds with an HttpOnly session cookie, and
 * the iframe then loads `/webview` riding on that cookie alone — no token
 * re-injection, session persists across navigation.
 */

export interface WebviewSessionUser {
    email: string | null;
    name: string | null;
}

/**
 * Exchange the signed-in user's token for an HttpOnly webview session cookie.
 * `credentials: "include"` is required so the Set-Cookie is stored. Returns the
 * user the proxy resolved from the token.
 */
export async function establishWebviewSession(bearerToken: string): Promise<WebviewSessionUser> {
    let response: Response;
    try {
        response = await fetch(`${webviewProxyBase}/api/webview/session`, {
            method: "POST",
            credentials: "include",
            headers: { Authorization: `Bearer ${bearerToken}` },
        });
    } catch {
        throw new Error(
            "Could not reach the local proxy. Start it with `npm run cors` (see the README, 'Native app → webview SSO' section)."
        );
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        body = undefined;
    }

    if (!response.ok) {
        const err = body as { error?: { message?: string } } | undefined;
        throw new Error(err?.error?.message ?? `HTTP ${response.status}`);
    }
    return (body as { user: WebviewSessionUser }).user;
}
