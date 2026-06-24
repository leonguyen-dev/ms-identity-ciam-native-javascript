"use client";

import {
    AuthenticatedTemplate,
    UnauthenticatedTemplate,
    useMsal,
} from "@azure/msal-react";
import { InteractionStatus } from "@azure/msal-browser";
import {
    appLabel,
    loginRequest,
    peerAppLabel,
    peerAppUrl,
    signInHintFromClaims,
} from "@/config/auth-config";

/**
 * Native app → system browser / separate web app SSO — Feature B / B3.
 *
 * This is the literal B2C `id_token_hint` flow, and the one place External ID
 * has NO supported answer: "cross-app SSO through system browsers isn't
 * supported with native authentication" (Microsoft Learn, confirmed for the
 * current release; a generic solution is "planned for a future release").
 *
 * Why it's a genuine gap (and why this web sample can't fake it away): a native
 * app authenticated with native auth holds its tokens IN THE APP — there is no
 * `ciamlogin.com` session cookie in any browser. So when it launches the system
 * browser to a separate web app, that browser is COLD: a silent `prompt=none`
 * request returns `login_required` and the user faces a full, cold sign-in. This
 * is exactly the opposite of B1 (web↔web), where the source is itself a browser
 * tab that shares the IdP cookie, so the silent path resolves.
 *
 * This page plays the NATIVE APP SHELL. It can't reproduce a cold browser (any
 * web page here shares the IdP cookie), so it demonstrates the chosen *interim*
 * instead — plan B3.2 option (b): hand off to the separate web app carrying a
 * `login_hint`, and have that app do an INTERACTIVE sign-in seeded with the hint.
 * The email is pre-filled, so with a registered passkey it is one tap — a big
 * improvement over a cold start, even though it is not true silent SSO. The
 * target reads `?handoff=1` in SsoBootstrap and forces the interactive path
 * (see auth/SsoBootstrap.tsx), faithfully modelling the missing session.
 *
 * The two other interim options (documented, not wired here): (a) make the app
 * browser-delegated so it uses the system browser + shared cookie jar and gets
 * B1 web SSO for free — the recommended direction if app↔web SSO is a hard
 * requirement (ties back to decision D1); (c) a custom session broker that
 * re-implements `id_token_hint` in the integration layer (security review
 * required; yields an app session, not an Entra token).
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
    note: (kind: "info" | "warn") => ({
        padding: "1rem 1.25rem",
        borderLeft: `0.25rem solid ${kind === "warn" ? "#b45309" : "#098851"}`,
        backgroundColor: kind === "warn" ? "#fef6e7" : "#e6f4ec",
        marginBottom: "1.5rem",
        lineHeight: 1.6,
    }),
    noteTitle: { fontWeight: 800, margin: "0 0 0.5rem 0" },
    stepList: { margin: "0 0 1.5rem 0", paddingLeft: "1.25rem", lineHeight: 1.7 },
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
    code: {
        backgroundColor: "#f0f0f0",
        padding: "0.1rem 0.35rem",
        borderRadius: "0.2rem",
        fontFamily: "ui-monospace, 'Cascadia Code', 'Consolas', monospace",
        fontSize: "0.9em",
    },
} as const;

function HandoffDemo() {
    const { instance } = useMsal();
    const account = instance.getActiveAccount() ?? instance.getAllAccounts()[0];
    const claims = account?.idTokenClaims as Record<string, unknown> | undefined;
    const hint = signInHintFromClaims(claims);

    // The handoff link to the separate web app (the "system browser" target).
    // `handoff=1` tells its SsoBootstrap to go straight to a seeded interactive
    // sign-in; `login_hint` pre-fills the user's email. Opened in a new tab with
    // rel=noopener so — when the target is a peer app on a different origin (App
    // B) — it starts with its own empty MSAL cache, i.e. genuinely signed out,
    // which is what makes the seeded interactive sign-in actually run.
    const handoffUrl = peerAppUrl
        ? `${peerAppUrl}/?handoff=1${hint ? `&login_hint=${encodeURIComponent(hint)}` : ""}`
        : undefined;

    return (
        <main style={styles.page}>
            <div style={styles.hero}>
                <div style={styles.heroInner}>
                    <h1 style={styles.heroTitle}>{`${appLabel} — native app → system browser SSO`}</h1>
                </div>
            </div>
            <div style={styles.wrap}>
                <div style={styles.card}>
                    <p style={styles.lead}>
                        This page plays the part of the <strong>native app shell</strong>. It is the one
                        cross-app SSO scenario External ID does <strong>not</strong> support: handing a
                        native app&rsquo;s session to a separate web app opened in the{" "}
                        <strong>system browser</strong> — the literal B2C <code style={styles.code}>id_token_hint</code>{" "}
                        flow (plan Feature B / B3).
                    </p>

                    <div style={styles.note("warn")}>
                        <p style={styles.noteTitle}>The gap (confirmed against Microsoft Learn)</p>
                        <p style={{ margin: 0 }}>
                            &ldquo;Cross-app SSO through system browsers isn&rsquo;t supported with native
                            authentication.&rdquo; Native auth supports SSO for <em>embedded web views only</em>{" "}
                            (that&rsquo;s the proven B2 path). A native app holds its tokens in-app, so the system
                            browser it launches has <strong>no Entra session cookie</strong> — a silent{" "}
                            <code style={styles.code}>prompt=none</code> request returns{" "}
                            <code style={styles.code}>login_required</code>. There is no minted hint token to carry
                            the session across, so true silent SSO is impossible here today.
                        </p>
                    </div>

                    <div style={styles.note("info")}>
                        <p style={styles.noteTitle}>The interim shown here (plan B3.2 option b)</p>
                        <p style={{ margin: 0 }}>
                            Hand off to the separate web app carrying a <code style={styles.code}>login_hint</code>,
                            and let it do an <strong>interactive</strong> sign-in <strong>seeded</strong> with that
                            hint. The email is pre-filled, so with a registered passkey it is <strong>one tap</strong>{" "}
                            — not silent SSO, but far better than a cold start. (Other interims: (a) switch the app
                            to <strong>browser-delegated</strong> so it shares the system cookie jar and gets B1 web
                            SSO for free — the recommended direction; (c) a custom session-broker that re-implements{" "}
                            <code style={styles.code}>id_token_hint</code>, security review required.)
                        </p>
                    </div>

                    {handoffUrl ? (
                        <>
                            <ol style={styles.stepList}>
                                <li>The button opens {peerAppLabel} in a new browser tab (the &ldquo;system browser&rdquo;).</li>
                                <li>
                                    The URL carries <code style={styles.code}>?handoff=1</code>
                                    {hint ? (
                                        <>
                                            {" "}and <code style={styles.code}>login_hint={hint}</code>
                                        </>
                                    ) : null}
                                    .
                                </li>
                                <li>
                                    {peerAppLabel} goes straight to an interactive sign-in with the email pre-filled —
                                    one tap to finish. (In this web sample the tab shares the IdP cookie, so we force
                                    the interactive path to model the cold browser a real native app launches.)
                                </li>
                            </ol>
                            <a
                                href={handoffUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={styles.primaryButton}
                            >
                                {`Open ${peerAppLabel} in the system browser`}
                            </a>
                        </>
                    ) : (
                        <div style={styles.note("warn")}>
                            <p style={styles.noteTitle}>No separate web app configured</p>
                            <p style={{ margin: 0 }}>
                                Set <code style={styles.code}>NEXT_PUBLIC_PEER_APP_URL</code> (and optionally{" "}
                                <code style={styles.code}>NEXT_PUBLIC_PEER_APP_LABEL</code>) to a second app instance
                                (&ldquo;App B&rdquo;) — the same two-instance setup the B1 cross-app SSO demo uses —
                                to enable the handoff button. See the README, &ldquo;Native app → system browser SSO&rdquo;.
                            </p>
                        </div>
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
                    <h1 style={styles.heroTitle}>{`${appLabel} — native app → system browser SSO`}</h1>
                </div>
            </div>
            <div style={styles.wrap}>
                <div style={styles.card}>
                    <p style={styles.lead}>
                        Sign in first — this demo shows how a signed-in app hands its user off to a separate
                        web app opened in the system browser.
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

export default function HandoffPage() {
    return (
        <>
            <AuthenticatedTemplate>
                <HandoffDemo />
            </AuthenticatedTemplate>
            <UnauthenticatedTemplate>
                <SignInPrompt />
            </UnauthenticatedTemplate>
        </>
    );
}
