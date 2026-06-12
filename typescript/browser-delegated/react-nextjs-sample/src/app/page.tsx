"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
    AuthenticatedTemplate,
    UnauthenticatedTemplate,
    useMsal,
} from "@azure/msal-react";
import { InteractionRequiredAuthError, InteractionStatus } from "@azure/msal-browser";
import { loginRequest, signUpRequest } from "@/config/auth-config";

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
    cardWrap: { maxWidth: "80rem", margin: "-2.5rem auto 2.5rem", padding: "0 2.5rem" },
    card: {
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        backgroundColor: "#ffffff",
    },
    column: { padding: "2rem 2.5rem" },
    columnLeft: { padding: "2rem 2.5rem", borderRight: "0.0625rem solid #d1d5db" },
    columnHeading: { fontSize: "1.875rem", fontWeight: 700, margin: "0 0 0.75rem 0", color: "#292929" },
    columnLead: { fontSize: "1rem", margin: "0 0 1.5rem 0", color: "#292929" },
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
    needTitle: { fontSize: "1rem", fontWeight: 700, margin: "1.75rem 0 1rem 0", color: "#404040" },
    needList: { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column" as const, gap: "1rem" },
    needItem: { display: "grid", gridTemplateColumns: "1.75rem 1fr", gap: "0.75rem", alignItems: "start" },
    needIcon: { color: "#267151", width: "1.5rem", height: "1.5rem", marginTop: "0.125rem" },
    needItemTitle: { fontWeight: 700, margin: "0 0 0.25rem 0", color: "#292929" },
    needItemBody: { margin: 0, color: "#292929", lineHeight: 1.5 },
    footerNote: { marginTop: "2rem", color: "#292929" },
    forgot: { display: "block", marginTop: "1rem", color: "#267151", fontWeight: 800, textDecoration: "underline" },
    signedInPanel: { padding: "1.25rem", border: "0.0625rem solid #d1d5db", borderRadius: "0.25rem" },
    tokenSectionTitle: { fontSize: "1.125rem", fontWeight: 800, margin: "1.5rem 0 0.75rem 0", color: "#292929" },
    claimsTable: { width: "100%", borderCollapse: "collapse" as const, fontSize: "0.9375rem" },
    claimRow: { borderBottom: "0.0625rem solid #e5e7eb" },
    claimKey: {
        padding: "0.5rem 1rem 0.5rem 0",
        fontWeight: 700,
        color: "#267151",
        verticalAlign: "top" as const,
        whiteSpace: "nowrap" as const,
        fontFamily: "ui-monospace, 'Cascadia Code', 'Consolas', monospace",
    },
    claimValue: {
        padding: "0.5rem 0",
        color: "#292929",
        wordBreak: "break-word" as const,
        fontFamily: "ui-monospace, 'Cascadia Code', 'Consolas', monospace",
    },
    claimValueSub: { color: "#6b7280", fontSize: "0.8125rem", marginLeft: "0.5rem" },
    rawTokenHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", margin: "1.5rem 0 0.75rem 0" },
    rawToken: {
        margin: 0,
        padding: "1rem",
        backgroundColor: "#1e1e1e",
        color: "#d4d4d4",
        borderRadius: "0.25rem",
        fontSize: "0.8125rem",
        lineHeight: 1.6,
        wordBreak: "break-all" as const,
        whiteSpace: "pre-wrap" as const,
        fontFamily: "ui-monospace, 'Cascadia Code', 'Consolas', monospace",
    },
    copyButton: {
        padding: "0.375rem 1rem",
        backgroundColor: "#267151",
        color: "#ffffff",
        border: "none",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "0.875rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
} as const;

function MailIcon() {
    return (
        <svg style={styles.needIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="5" width="18" height="14" rx="1" />
            <path d="m3 7 9 6 9-6" />
        </svg>
    );
}

function PhoneIcon() {
    return (
        <svg style={styles.needIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="7" y="2" width="10" height="20" rx="2" />
            <path d="M11 18h2" />
        </svg>
    );
}

const TIME_CLAIMS = new Set(["exp", "iat", "nbf", "auth_time"]);

function SignedInView() {
    const { instance } = useMsal();
    const account = instance.getActiveAccount() ?? instance.getAllAccounts()[0];

    const [idToken, setIdToken] = useState<string | undefined>(undefined);
    const [claims, setClaims] = useState<Record<string, unknown> | undefined>(
        account?.idTokenClaims as Record<string, unknown> | undefined
    );
    const [copied, setCopied] = useState(false);

    // AccountInfo carries the decoded idTokenClaims but not the raw JWT string,
    // so acquire it silently from cache to display the raw token too.
    //
    // Depend on the stable homeAccountId string, NOT the account object:
    // getActiveAccount()/getAllAccounts() return a fresh object reference on every
    // render, so keying the effect on `account` would re-run it every render and
    // loop ("Maximum update depth exceeded"). Re-fetch the account inside instead.
    const accountId = account?.homeAccountId;
    useEffect(() => {
        const activeAccount = instance.getActiveAccount() ?? instance.getAllAccounts()[0];
        if (!activeAccount) return;
        instance
            .acquireTokenSilent({ ...loginRequest, account: activeAccount })
            .then((result) => {
                setIdToken(result.idToken);
                if (result.idTokenClaims) {
                    setClaims(result.idTokenClaims as Record<string, unknown>);
                }
            })
            .catch((err) => {
                // Cache miss / expired — claims from the account are still shown.
                if (!(err instanceof InteractionRequiredAuthError)) {
                    console.warn("acquireTokenSilent failed", err);
                }
            });
    }, [instance, accountId]);

    const formatClaimValue = (key: string, value: unknown) => {
        if (TIME_CLAIMS.has(key) && typeof value === "number") {
            return (
                <>
                    {value}
                    <span style={styles.claimValueSub}>{new Date(value * 1000).toLocaleString()}</span>
                </>
            );
        }
        if (typeof value === "object" && value !== null) {
            return JSON.stringify(value, null, 2);
        }
        return String(value);
    };

    const copyToken = () => {
        if (!idToken) return;
        navigator.clipboard.writeText(idToken).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    return (
        <main style={styles.page}>
            <div style={styles.hero}>
                <div style={styles.heroInner}>
                    <h1 style={styles.heroTitle}>Welcome to myServiceTas</h1>
                </div>
            </div>
            <div style={styles.cardWrap}>
                <div style={{ ...styles.card, gridTemplateColumns: "1fr" }}>
                    <div style={styles.column}>
                        <div style={styles.signedInPanel}>
                            {`The user '${account?.username ?? "unknown"}' has signed in`}
                        </div>

                        <Link href="/account" style={{ ...styles.primaryButton, marginTop: "1.5rem" }}>
                            Manage my account
                        </Link>

                        {claims && (
                            <>
                                <h2 style={styles.tokenSectionTitle}>ID token claims</h2>
                                <table style={styles.claimsTable}>
                                    <tbody>
                                        {Object.entries(claims).map(([key, value]) => (
                                            <tr key={key} style={styles.claimRow}>
                                                <td style={styles.claimKey}>{key}</td>
                                                <td style={styles.claimValue}>{formatClaimValue(key, value)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </>
                        )}

                        {idToken && (
                            <>
                                <div style={styles.rawTokenHeader}>
                                    <h2 style={{ ...styles.tokenSectionTitle, margin: 0 }}>Raw ID token</h2>
                                    <button type="button" style={styles.copyButton} onClick={copyToken}>
                                        {copied ? "Copied!" : "Copy"}
                                    </button>
                                </div>
                                <p style={styles.rawToken}>{idToken}</p>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </main>
    );
}

function SignedOutView() {
    const { instance, inProgress } = useMsal();
    const busy = inProgress !== InteractionStatus.None;

    return (
        <main style={styles.page}>
            <div style={styles.hero}>
                <div style={styles.heroInner}>
                    <h1 style={styles.heroTitle}>Welcome to myServiceTas</h1>
                </div>
            </div>

            <div style={styles.cardWrap}>
                <div style={styles.card}>
                    <section style={styles.columnLeft}>
                        <h2 style={styles.columnHeading}>New here? Create an account</h2>
                        <p style={styles.columnLead}>Create an account if you are new to this portal.</p>

                        <button
                            style={styles.primaryButton}
                            onClick={() => instance.loginRedirect(signUpRequest)}
                            disabled={busy}
                        >
                            Create an account
                        </button>

                        <p style={styles.needTitle}>You will need</p>
                        <ul style={styles.needList}>
                            <li style={styles.needItem}>
                                <MailIcon />
                                <div>
                                    <p style={styles.needItemTitle}>An individual email address</p>
                                    <p style={styles.needItemBody}>
                                        You cannot use a school email address or one you share with someone else. An
                                        email address can only be used for one account.
                                    </p>
                                </div>
                            </li>
                            <li style={styles.needItem}>
                                <PhoneIcon />
                                <div>
                                    <p style={styles.needItemTitle}>Mobile phone number</p>
                                    <p style={styles.needItemBody}>
                                        We use multi-factor authentication to help keep your account secure. You will
                                        need your mobile phone whenever you log in.
                                    </p>
                                </div>
                            </li>
                        </ul>

                        <p style={styles.footerNote}>
                            If you have questions or would like more information about myServiceTas, please visit the{" "}
                            <a href="https://www.service.tas.gov.au/" target="_blank" rel="noreferrer">
                                Service Tasmania website.
                            </a>
                        </p>
                    </section>

                    <section style={styles.column}>
                        <h2 style={styles.columnHeading}>Log in to myServiceTas</h2>
                        <p style={styles.columnLead}>
                            If you have already created an account please log in. You will be taken to the secure
                            Service Tasmania sign-in page.
                        </p>

                        <button
                            style={styles.primaryButton}
                            onClick={() => instance.loginRedirect(loginRequest)}
                            disabled={busy}
                        >
                            Log in
                        </button>

                        <Link href="/reset-password" style={styles.forgot}>
                            Forgot my password
                        </Link>
                    </section>
                </div>
            </div>
        </main>
    );
}

export default function Home() {
    return (
        <>
            <AuthenticatedTemplate>
                <SignedInView />
            </AuthenticatedTemplate>
            <UnauthenticatedTemplate>
                <SignedOutView />
            </UnauthenticatedTemplate>
        </>
    );
}
