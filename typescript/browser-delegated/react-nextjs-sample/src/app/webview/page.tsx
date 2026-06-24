"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    AuthenticatedTemplate,
    UnauthenticatedTemplate,
    useMsal,
} from "@azure/msal-react";
import { InteractionRequiredAuthError, InteractionStatus } from "@azure/msal-browser";
import {
    appLabel,
    loginRequest,
    silentRequest,
    webviewFeatureAvailable,
} from "@/config/auth-config";
import { establishWebviewSession, webviewContentUrl } from "@/services/webview-service";

/**
 * Native app → in-app web content (embedded webview) SSO demo — Feature B / B2.
 *
 * This page plays the part of the NATIVE APP SHELL. In a real native app the SDK
 * would acquire a token and inject `Authorization: Bearer <token>` straight onto
 * the webview's first request. A browser can't set headers on an <iframe>
 * navigation, so here the shell:
 *   1. silently acquires the signed-in user's token (acquireTokenSilent),
 *   2. POSTs it to the web resource's /api/webview/session (the proxy), which
 *      validates aud/iss and sets an HttpOnly session cookie (B2.2 / B2.3),
 *   3. loads the protected content in the <iframe>, which rides the cookie with
 *      no second prompt and keeps it across in-webview navigation (B2.4).
 */

const styles = {
    page: {
        backgroundColor: "#f5f5f5",
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
    },
} as const;

function WebviewDemo() {
    const { instance } = useMsal();
    const [status, setStatus] = useState<{ kind: "info" | "ok" | "error"; text: string }>({
        kind: "info",
        text: "Establishing webview session…",
    });
    const [iframeReady, setIframeReady] = useState(false);
    const [available, setAvailable] = useState(true);
    const started = useRef(false);

    useEffect(() => setAvailable(webviewFeatureAvailable()), []);

    const start = useCallback(async () => {
        const account = instance.getActiveAccount() ?? instance.getAllAccounts()[0];
        if (!account) return;
        setIframeReady(false);
        setStatus({ kind: "info", text: "Acquiring a token for the web resource…" });
        try {
            // Step 1 — the "native SDK" acquires the token silently.
            const result = await instance.acquireTokenSilent({ ...silentRequest, account });
            // Steps 2/3 — inject it once; the proxy returns an HttpOnly cookie.
            setStatus({ kind: "info", text: "Exchanging the token for a webview session…" });
            const user = await establishWebviewSession(result.idToken);
            setStatus({
                kind: "ok",
                text: `Webview session established for ${user.email ?? "this user"} — loading content with no second prompt.`,
            });
            setIframeReady(true);
        } catch (err) {
            if (err instanceof InteractionRequiredAuthError) {
                setStatus({ kind: "error", text: "Your session needs a refresh — please sign in again." });
                return;
            }
            setStatus({
                kind: "error",
                text: err instanceof Error ? err.message : "Could not establish the webview session.",
            });
        }
    }, [instance]);

    useEffect(() => {
        if (!available || started.current) return;
        started.current = true;
        void start();
    }, [available, start]);

    return (
        <main style={styles.page}>
            <div style={styles.hero}>
                <div style={styles.heroInner}>
                    <h1 style={styles.heroTitle}>{`${appLabel} — in-app web content (webview SSO)`}</h1>
                </div>
            </div>
            <div style={styles.wrap}>
                <div style={styles.card}>
                    <p style={styles.lead}>
                        This page acts as the <strong>native app shell</strong>. It silently acquires the
                        signed-in user&rsquo;s token, injects it once to establish an <code>HttpOnly</code>{" "}
                        session cookie on the web resource, then shows that web content in the embedded
                        webview below — signed in, with <strong>no second prompt</strong>. This is the
                        supported replacement for B2C&rsquo;s <code>id_token_hint</code> for in-app web content
                        (plan Feature B / B2).
                    </p>

                    {!available ? (
                        <div style={styles.status("error")}>
                            The webview demo needs the local proxy (<code>npm run proxy</code>) and runs on{" "}
                            <code>localhost</code>. It is disabled on this host.
                        </div>
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

function SignInPrompt() {
    const { instance, inProgress } = useMsal();
    return (
        <main style={styles.page}>
            <div style={styles.hero}>
                <div style={styles.heroInner}>
                    <h1 style={styles.heroTitle}>{`${appLabel} — webview SSO`}</h1>
                </div>
            </div>
            <div style={styles.wrap}>
                <div style={styles.card}>
                    <p style={styles.lead}>
                        Sign in first — this demo shows how a signed-in app passes its session to embedded
                        web content with no second prompt.
                    </p>
                    <button
                        type="button"
                        style={styles.primaryButton}
                        onClick={() => instance.loginRedirect(loginRequest)}
                        disabled={inProgress !== InteractionStatus.None}
                    >
                        Log in
                    </button>
                </div>
            </div>
        </main>
    );
}

export default function WebviewPage() {
    return (
        <>
            <AuthenticatedTemplate>
                <WebviewDemo />
            </AuthenticatedTemplate>
            <UnauthenticatedTemplate>
                <SignInPrompt />
            </UnauthenticatedTemplate>
        </>
    );
}
