"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CustomAuthAccountData } from "@azure/msal-browser/custom-auth";
import { useAuthClient } from "@/auth/AuthClientProvider";
import { webviewContentUrl, webviewFeatureAvailable } from "@/config/auth-config";
import { establishWebviewSession } from "@/services/webview-service";

/**
 * Native app → in-app web content (embedded webview) SSO demo — Feature B / B2.
 *
 * This page plays the part of the NATIVE APP SHELL. It implements the supported
 * flow from
 * https://learn.microsoft.com/entra/identity-platform/how-to-native-authentication-webview-sso:
 *
 *   1. The user has already signed in with native authentication (the rest of
 *      this sample), so the SDK holds a valid token.
 *   2. Before loading the webview, the shell retrieves that token
 *      (accountData.getIdToken() here; in production accountData.getAccessToken({
 *      scopes }) for the web resource's API scope) and injects it as
 *      `Authorization: Bearer <token>`. A browser can't set a header on an
 *      <iframe> navigation the way a native WebView can, so the shell POSTs the
 *      token to the web resource's /api/webview/session with a credentialed fetch.
 *   3. The web resource (cors.js) validates iss/aud/tid/sig/exp and returns an
 *      HttpOnly session cookie.
 *   4. The iframe loads the protected content, which rides the cookie alone with
 *      no second prompt and keeps it across in-webview navigation.
 */

const styles = {
    page: {
        backgroundColor: "#f5f5f5",
        minHeight: "calc(100vh - 3.75rem)",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        color: "#292929",
    },
    hero: { backgroundColor: "#098851", padding: "3.75rem 0" },
    heroInner: { maxWidth: "80rem", margin: "0 auto", padding: "0 2.5rem" },
    heroTitle: { color: "#ffffff", fontSize: "2rem", fontWeight: 700, margin: 0 },
    wrap: { maxWidth: "80rem", margin: "-2.5rem auto 2.5rem", padding: "0 2.5rem" },
    card: { backgroundColor: "#ffffff", padding: "2rem 2.5rem" },
    lead: { fontSize: "1rem", margin: "0 0 1.5rem 0", lineHeight: 1.6 },
    status: (kind: "info" | "ok" | "error") => ({
        padding: "0.75rem 1rem",
        borderRadius: "0.25rem",
        marginBottom: "1.5rem",
        fontWeight: 700,
        backgroundColor: kind === "error" ? "#fdecea" : kind === "ok" ? "#e6f4ec" : "#eef2f7",
        color: kind === "error" ? "#b3261e" : kind === "ok" ? "#098851" : "#404040",
    }),
    deviceFrame: {
        maxWidth: "26rem",
        margin: "0 auto",
        border: "0.75rem solid #1e1e1e",
        borderRadius: "1.75rem",
        overflow: "hidden" as const,
        backgroundColor: "#000",
    },
    deviceBar: {
        color: "#fff",
        fontSize: "0.8125rem",
        textAlign: "center" as const,
        padding: "0.5rem",
        fontWeight: 700,
    },
    iframe: {
        display: "block",
        width: "100%",
        height: "26rem",
        border: "none",
        backgroundColor: "#fff",
    },
    primaryButton: {
        display: "inline-block",
        padding: "0.75rem 3rem",
        backgroundColor: "#267151",
        color: "#ffffff",
        border: "none",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "1rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        textDecoration: "none",
    },
} as const;

export default function WebviewPage() {
    const authClient = useAuthClient();

    const [available, setAvailable] = useState(true);
    const [signedIn, setSignedIn] = useState<boolean | null>(null);
    const [status, setStatus] = useState<{ kind: "info" | "ok" | "error"; text: string }>({
        kind: "info",
        text: "Establishing webview session…",
    });
    const [iframeReady, setIframeReady] = useState(false);
    const started = useRef(false);

    useEffect(() => setAvailable(webviewFeatureAvailable()), []);

    const start = useCallback(async () => {
        if (!authClient) return;

        const accountResult = authClient.getCurrentAccount();
        if (!accountResult.isCompleted() || !accountResult.data) {
            setSignedIn(false);
            return;
        }
        setSignedIn(true);

        const account: CustomAuthAccountData = accountResult.data;
        setIframeReady(false);
        setStatus({ kind: "info", text: "Acquiring a token for the web resource…" });

        // Step 2 — the "native SDK" hands back the signed-in user's token. We use
        // the ID token (its aud is this clientId, so the sample needs no extra
        // Entra setup); production would call account.getAccessToken({ scopes })
        // for the web resource's API scope and inject that instead.
        const bearer = account.getIdToken();
        if (!bearer) {
            setStatus({
                kind: "error",
                text: "No token available — sign in again before opening the webview.",
            });
            return;
        }

        try {
            // Steps 2/3 — inject the token once; the proxy returns an HttpOnly cookie.
            setStatus({ kind: "info", text: "Exchanging the token for a webview session…" });
            const user = await establishWebviewSession(bearer);
            setStatus({
                kind: "ok",
                text: `Webview session established for ${user.email ?? "this user"} — loading content with no second prompt.`,
            });
            setIframeReady(true);
        } catch (err) {
            setStatus({
                kind: "error",
                text: err instanceof Error ? err.message : "Could not establish the webview session.",
            });
        }
    }, [authClient]);

    useEffect(() => {
        if (!authClient || !available || started.current) return;
        started.current = true;
        void start();
    }, [authClient, available, start]);

    return (
        <main style={styles.page}>
            <div style={styles.hero}>
                <div style={styles.heroInner}>
                    <h1 style={styles.heroTitle}>myServiceTas — in-app web content (webview SSO)</h1>
                </div>
            </div>
            <div style={styles.wrap}>
                <div style={styles.card}>
                    <p style={styles.lead}>
                        This page acts as the <strong>native app shell</strong>. After you sign in with
                        native authentication, it retrieves your token, injects it once to establish an{" "}
                        <code>HttpOnly</code> session cookie on the web resource, then shows that web
                        content in the embedded webview below — signed in, with{" "}
                        <strong>no second prompt</strong>. This is the supported SSO pattern for in-app web
                        content (plan Feature B / B2).
                    </p>

                    {!available ? (
                        <div style={styles.status("error")}>
                            Preparing the webview demo…
                        </div>
                    ) : signedIn === false ? (
                        <>
                            <div style={styles.status("info")}>
                                Sign in first — this demo shows how a signed-in app passes its session to
                                embedded web content with no second prompt.
                            </div>
                            <Link href="/" style={styles.primaryButton}>
                                Go to sign in
                            </Link>
                        </>
                    ) : (
                        <>
                            <div style={styles.status(status.kind)}>{status.text}</div>

                            {iframeReady && (
                                <div style={styles.deviceFrame}>
                                    <div style={styles.deviceBar}>Embedded webview</div>
                                    <iframe
                                        title="In-app web content"
                                        src={webviewContentUrl()}
                                        style={styles.iframe}
                                    />
                                </div>
                            )}

                            {status.kind === "error" && (
                                <button
                                    type="button"
                                    style={{ ...styles.primaryButton, marginTop: "1.5rem" }}
                                    onClick={() => {
                                        started.current = false;
                                        void start();
                                    }}
                                >
                                    Retry
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>
        </main>
    );
}
