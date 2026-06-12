"use client";

import { useCallback, useEffect, useState } from "react";
import {
    AuthenticatedTemplate,
    UnauthenticatedTemplate,
    useMsal,
} from "@azure/msal-react";
import {
    AuthError,
    InteractionRequiredAuthError,
    InteractionStatus,
} from "@azure/msal-browser";
import Link from "next/link";
import { loginRequest, ngcmfaClaims } from "@/config/auth-config";
import {
    AccountApiError,
    AccountSummary,
    changePhone,
    changeSignInName,
    fetchAccountSummary,
} from "@/services/account-service";

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
    card: { backgroundColor: "#ffffff", padding: "2.5rem 4rem" },
    content: { maxWidth: "44rem", margin: "0 auto" },
    heading: { fontSize: "1.875rem", fontWeight: 700, margin: "0 0 0.75rem 0" },
    lead: { fontSize: "1rem", margin: "0 0 1.5rem 0", lineHeight: 1.6 },
    banner: { padding: "0.875rem 1rem", margin: "0 0 1.5rem 0", fontSize: "0.9375rem", lineHeight: 1.5 },
    bannerInfo: { backgroundColor: "#eef6f2", border: "0.0625rem solid #267151" },
    bannerSuccess: { backgroundColor: "#eef6f2", border: "0.0625rem solid #098851", fontWeight: 700 },
    bannerError: { backgroundColor: "#fdf2f2", border: "0.0625rem solid #b91c1c" },
    section: { border: "0.0625rem solid #d1d5db", marginBottom: "0.75rem" },
    sectionHeader: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "1rem",
        padding: "1.25rem 1.5rem",
    },
    sectionTitle: { fontWeight: 800, margin: "0 0 0.25rem 0", fontSize: "1.0625rem" },
    sectionMeta: { margin: 0, color: "#6b7280", fontSize: "0.875rem", wordBreak: "break-word" as const },
    sectionBody: { padding: "0 1.5rem 1.5rem 1.5rem" },
    inputLabel: { display: "block", fontWeight: 700, margin: "0.5rem 0 0.375rem 0" },
    input: {
        display: "block",
        width: "100%",
        maxWidth: "26rem",
        padding: "0.625rem 0.75rem",
        margin: "0 0 1rem 0",
        border: "0.0625rem solid #6b7280",
        borderRadius: "0",
        fontSize: "1rem",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        boxSizing: "border-box" as const,
    },
    hint: { margin: "-0.5rem 0 1rem 0", color: "#6b7280", fontSize: "0.8125rem", lineHeight: 1.5 },
    buttonRow: { display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" as const },
    primaryButton: {
        padding: "0.625rem 2rem",
        backgroundColor: "#267151",
        color: "#ffffff",
        border: "none",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "1rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    toggleButton: {
        padding: "0.5rem 1.25rem",
        backgroundColor: "#ffffff",
        color: "#267151",
        border: "0.0625rem solid #267151",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "0.875rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        whiteSpace: "nowrap" as const,
    },
} as const;

type Banner = { kind: "info" | "success" | "error"; text: string } | null;
type SectionKey = "password" | "signin" | "phone";
// Password is handled by the hosted SSPR flow (Graph has no app-only password
// path in External ID), so only these two go through the Graph proxy.
type ChangeKey = "signin" | "phone";

const PENDING_ACTION_KEY = "accountPendingAction";

// One MFA redirect per save attempt. If the user cancels/abandons the hosted
// MFA page, the resumed attempt fails the silent request again — without this
// cap it would immediately redirect again, looping forever.
const MAX_MFA_REDIRECTS = 1;

interface PendingAction {
    action: ChangeKey;
    value: string;
    /** How many MFA redirects this save attempt has already been through. */
    attempts?: number;
}

function bannerStyle(kind: NonNullable<Banner>["kind"]) {
    const variant =
        kind === "success" ? styles.bannerSuccess : kind === "error" ? styles.bannerError : styles.bannerInfo;
    return { ...styles.banner, ...variant };
}

function AccountManager() {
    const { instance, inProgress } = useMsal();

    const [summary, setSummary] = useState<AccountSummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [banner, setBanner] = useState<Banner>(null);
    const [open, setOpen] = useState<SectionKey | null>(null);
    const [email, setEmail] = useState("");
    const [phone, setPhone] = useState("");

    const getAccount = useCallback(
        () => instance.getActiveAccount() ?? instance.getAllAccounts()[0],
        [instance]
    );

    /** Cached token — good enough for the read-only summary call. */
    const getListToken = useCallback(async () => {
        const result = await instance.acquireTokenSilent({
            scopes: loginRequest.scopes,
            account: getAccount(),
        });
        return result.idToken;
    }, [instance, getAccount]);

    /** Stash the attempted action (counting this redirect) and bounce through MFA. */
    const redirectForMfa = useCallback(
        async (pending: PendingAction) => {
            sessionStorage.setItem(
                PENDING_ACTION_KEY,
                JSON.stringify({ ...pending, attempts: (pending.attempts ?? 0) + 1 })
            );
            setBanner({
                kind: "info",
                text: "To keep your account secure, you need to verify your identity (multi-factor authentication). Redirecting…",
            });
            await instance.acquireTokenRedirect({
                scopes: loginRequest.scopes,
                claims: ngcmfaClaims,
                account: getAccount(),
            });
        },
        [instance, getAccount]
    );

    /**
     * Token carrying the ngcmfa claims challenge for a change. If the user's MFA
     * isn't fresh enough, Entra refuses the silent request; we stash the
     * attempted action and bounce through an interactive redirect so the user
     * can complete MFA, then resume on return (see the pending-action effect).
     */
    const getFreshMfaToken = useCallback(
        async (pending: PendingAction): Promise<string | null> => {
            try {
                const result = await instance.acquireTokenSilent({
                    scopes: loginRequest.scopes,
                    claims: ngcmfaClaims,
                    account: getAccount(),
                });
                return result.idToken;
            } catch (error) {
                const needsInteraction =
                    error instanceof InteractionRequiredAuthError ||
                    (error instanceof AuthError && error.errorCode === "invalid_grant");
                if (!needsInteraction) throw error;

                if ((pending.attempts ?? 0) >= MAX_MFA_REDIRECTS) {
                    // Already bounced through MFA for this save (the user likely
                    // cancelled it) — fail with a message instead of looping.
                    throw new Error(
                        "Identity verification wasn't completed. Select Save to try again."
                    );
                }
                await redirectForMfa(pending);
                return null; // navigation takes over
            }
        },
        [instance, getAccount, redirectForMfa]
    );

    const loadSummary = useCallback(async () => {
        setLoading(true);
        try {
            const token = await getListToken();
            setSummary(await fetchAccountSummary(token));
        } catch (error) {
            setBanner({ kind: "error", text: `Could not load your account: ${(error as Error).message}` });
        } finally {
            setLoading(false);
        }
    }, [getListToken]);

    const performChange = useCallback(
        async (action: ChangeKey, value: string, attempts = 0) => {
            setBusy(true);
            setBanner(null);
            try {
                const token = await getFreshMfaToken({ action, value, attempts });
                if (!token) return; // redirecting for MFA

                const message =
                    action === "signin"
                        ? await changeSignInName(token, value)
                        : await changePhone(token, value);

                setBanner({ kind: "success", text: message });
                setOpen(null);
                setEmail("");
                setPhone("");
                // The saved value is authoritative from the 200 response — show
                // it directly rather than re-reading Graph, which can lag the
                // write by a few seconds.
                setSummary((prev) =>
                    prev === null
                        ? prev
                        : action === "signin"
                          ? { ...prev, email: value }
                          : { ...prev, phoneNumber: value }
                );
            } catch (error) {
                if (
                    error instanceof AccountApiError &&
                    error.code === "mfa_required" &&
                    attempts < MAX_MFA_REDIRECTS
                ) {
                    // The proxy judged our token's MFA not fresh enough even
                    // though MSAL had one cached — same remedy as a refused
                    // silent request: bounce through interactive MFA.
                    await redirectForMfa({ action, value, attempts });
                    return;
                }
                setBanner({ kind: "error", text: `Could not save the change: ${(error as Error).message}` });
            } finally {
                setBusy(false);
            }
        },
        [getFreshMfaToken, redirectForMfa]
    );

    // Initial load + resume an action interrupted by the MFA redirect.
    useEffect(() => {
        if (inProgress !== InteractionStatus.None) return;

        const stored = sessionStorage.getItem(PENDING_ACTION_KEY);
        if (stored) {
            sessionStorage.removeItem(PENDING_ACTION_KEY);
            try {
                const pending = JSON.parse(stored) as PendingAction;
                void loadSummary().then(() =>
                    performChange(pending.action, pending.value, pending.attempts ?? 0)
                );
                return;
            } catch {
                // fall through to a plain load
            }
        }
        void loadSummary();
        // Run once per completed interaction cycle.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inProgress]);

    const toggle = (key: SectionKey) => {
        setBanner(null);
        setOpen((current) => (current === key ? null : key));
    };

    const renderSection = (
        key: SectionKey,
        title: string,
        meta: string,
        body: React.ReactNode
    ) => (
        <div style={styles.section}>
            <div style={styles.sectionHeader}>
                <div>
                    <p style={styles.sectionTitle}>{title}</p>
                    <p style={styles.sectionMeta}>{meta}</p>
                </div>
                <button
                    type="button"
                    style={styles.toggleButton}
                    onClick={() => toggle(key)}
                    disabled={busy}
                >
                    {open === key ? "Cancel" : "Change"}
                </button>
            </div>
            {open === key && <div style={styles.sectionBody}>{body}</div>}
        </div>
    );

    return (
        <main style={styles.page}>
            <div style={styles.hero}>
                <div style={styles.heroInner}>
                    <h1 style={styles.heroTitle}>My account</h1>
                </div>
            </div>
            <div style={styles.cardWrap}>
                <div style={styles.card}>
                    <div style={styles.content}>
                        <h2 style={styles.heading}>Manage your sign-in details</h2>
                        <p style={styles.lead}>
                            Update your password, the email you sign in with, or your multi-factor
                            authentication phone number. Changing your sign-in email or phone number asks you
                            to verify your identity first.
                        </p>

                        {banner && <div style={bannerStyle(banner.kind)}>{banner.text}</div>}

                        {loading ? (
                            <p style={styles.sectionMeta}>Loading your account…</p>
                        ) : (
                            <>
                                {renderSection(
                                    "password",
                                    "Change password",
                                    "Reset your password from the secure sign-in page.",
                                    <>
                                        <p style={styles.hint}>
                                            Microsoft Entra External ID handles password changes through its
                                            secure self-service reset. Select the button below, then on the
                                            sign-in page enter your email and choose{" "}
                                            <strong>Forgot my password</strong> to verify your identity and set
                                            a new password.
                                        </p>
                                        <div style={styles.buttonRow}>
                                            <Link href="/reset-password" style={styles.primaryButton}>
                                                Go to password reset
                                            </Link>
                                        </div>
                                    </>
                                )}

                                {renderSection(
                                    "signin",
                                    "Change sign in name",
                                    summary?.email
                                        ? `You currently sign in with ${summary.email}.`
                                        : "Update the email address you sign in with.",
                                    <>
                                        <label style={styles.inputLabel} htmlFor="new-email">
                                            New sign-in email
                                        </label>
                                        <input
                                            id="new-email"
                                            type="email"
                                            style={styles.input}
                                            value={email}
                                            placeholder={summary?.email ?? "you@example.com"}
                                            autoComplete="email"
                                            onChange={(e) => setEmail(e.target.value)}
                                        />
                                        <p style={styles.hint}>
                                            Use the new email the next time you sign in. It must not already be
                                            registered to another account.
                                        </p>
                                        <div style={styles.buttonRow}>
                                            <button
                                                type="button"
                                                style={styles.primaryButton}
                                                disabled={busy || email.trim().length === 0}
                                                onClick={() => performChange("signin", email.trim())}
                                            >
                                                {busy ? "Saving…" : "Save email"}
                                            </button>
                                        </div>
                                    </>
                                )}

                                {renderSection(
                                    "phone",
                                    "Change phone number",
                                    summary?.phoneNumber
                                        ? `Your current mobile number is ${summary.phoneNumber}.`
                                        : "Add or update the mobile number used for multi-factor authentication.",
                                    <>
                                        <label style={styles.inputLabel} htmlFor="new-phone">
                                            New mobile number
                                        </label>
                                        <input
                                            id="new-phone"
                                            type="tel"
                                            style={styles.input}
                                            value={phone}
                                            placeholder="+61 412345678"
                                            autoComplete="tel"
                                            onChange={(e) => setPhone(e.target.value)}
                                        />
                                        <p style={styles.hint}>
                                            Enter the number in international format, starting with the country
                                            code (e.g. +61 for Australia).
                                        </p>
                                        <div style={styles.buttonRow}>
                                            <button
                                                type="button"
                                                style={styles.primaryButton}
                                                disabled={busy || phone.trim().length === 0}
                                                onClick={() => performChange("phone", phone.trim())}
                                            >
                                                {busy ? "Saving…" : "Save number"}
                                            </button>
                                        </div>
                                    </>
                                )}
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
                    <h1 style={styles.heroTitle}>My account</h1>
                </div>
            </div>
            <div style={styles.cardWrap}>
                <div style={styles.card}>
                    <div style={styles.content}>
                        <h2 style={styles.heading}>Please sign in</h2>
                        <p style={styles.lead}>You need to be signed in to manage your account details.</p>
                        <button
                            type="button"
                            style={styles.primaryButton}
                            onClick={() => instance.loginRedirect(loginRequest)}
                            disabled={busy}
                        >
                            Log in
                        </button>
                    </div>
                </div>
            </div>
        </main>
    );
}

export default function AccountPage() {
    return (
        <>
            <AuthenticatedTemplate>
                <AccountManager />
            </AuthenticatedTemplate>
            <UnauthenticatedTemplate>
                <SignedOutView />
            </UnauthenticatedTemplate>
        </>
    );
}
