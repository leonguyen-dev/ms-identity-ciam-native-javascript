"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CustomAuthAccountData } from "@azure/msal-browser/custom-auth";
import { useAuthClient } from "@/auth/AuthClientProvider";
import { accountFeatureAvailable } from "@/config/auth-config";
import {
    AccountApiError,
    AccountSummary,
    changePhone,
    changeSignInName,
    fetchAccountSummary,
    sendSignInNameOtp,
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
    phoneRow: {
        display: "flex",
        gap: "0.75rem",
        alignItems: "stretch",
        width: "100%",
        maxWidth: "26rem",
        margin: "0 0 1rem 0",
    },
    dialSelect: {
        padding: "0.625rem 0.75rem",
        border: "0.0625rem solid #6b7280",
        borderRadius: "0",
        fontSize: "1rem",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        color: "#292929",
        backgroundColor: "#ffffff",
        boxSizing: "border-box" as const,
        flexShrink: 0,
    },
    phoneInput: {
        flex: 1,
        minWidth: 0,
        padding: "0.625rem 0.75rem",
        border: "0.0625rem solid #6b7280",
        borderRadius: "0",
        fontSize: "1rem",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        boxSizing: "border-box" as const,
    },
    hint: { margin: "-0.5rem 0 1rem 0", color: "#6b7280", fontSize: "0.8125rem", lineHeight: 1.5 },
    buttonRow: { display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" as const },
    primaryButton: {
        display: "inline-block",
        padding: "0.625rem 2rem",
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
// Password is handled by the native self-service reset flow (Graph has no app-only
// password path in External ID), so only these two go through the Graph proxy.
type ChangeKey = "signin" | "phone";

// Mirrors the native-auth sign-up flow: a fixed dial-code dropdown plus a local
// number. The submitted value is `${dialCode} ${localNumber}`, e.g. "+61 412345678".
const DIAL_CODES = [
    { code: "+61", label: "Australia (+61)" },
    { code: "+64", label: "New Zealand (+64)" },
];

/** Strip non-digits and any leading zero so it can be paired with a dial code. */
function toLocalNumber(mobile: string): string {
    return mobile.replace(/\D/g, "").replace(/^0+/, "");
}

function bannerStyle(kind: NonNullable<Banner>["kind"]) {
    const variant =
        kind === "success" ? styles.bannerSuccess : kind === "error" ? styles.bannerError : styles.bannerInfo;
    return { ...styles.banner, ...variant };
}

function AccountManager({ accountData }: { accountData: CustomAuthAccountData }) {
    const [summary, setSummary] = useState<AccountSummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [banner, setBanner] = useState<Banner>(null);
    const [open, setOpen] = useState<SectionKey | null>(null);
    const [email, setEmail] = useState("");
    const [otp, setOtp] = useState("");
    // True once a verification code has been emailed to the new address — reveals
    // the code input and switches the primary button to "Verify & save".
    const [otpSent, setOtpSent] = useState(false);
    const [phone, setPhone] = useState("");
    const [dialCode, setDialCode] = useState("+61");

    /**
     * The signed-in user's ID token. Unlike the browser-delegated sample there is
     * no silent step-up: native auth completed SMS MFA at sign-in, so a freshly
     * issued token is what proves recent MFA. The proxy's `iat`-freshness gate
     * enforces that; if the token is too old it answers `mfa_required` and we ask
     * the user to sign in again (see performChange).
     */
    const getToken = useCallback((): string | null => {
        return accountData.getIdToken() ?? null;
    }, [accountData]);

    const loadSummary = useCallback(async () => {
        setLoading(true);
        try {
            const token = getToken();
            if (!token) throw new Error("You're not signed in. Sign in and try again.");
            setSummary(await fetchAccountSummary(token));
        } catch (error) {
            setBanner({ kind: "error", text: `Could not load your account: ${(error as Error).message}` });
        } finally {
            setLoading(false);
        }
    }, [getToken]);

    /** Email a verification code to the prospective new sign-in address. */
    const sendOtp = useCallback(async () => {
        setBusy(true);
        setBanner(null);
        try {
            const token = getToken();
            if (!token) throw new Error("You're not signed in. Sign in and try again.");
            const message = await sendSignInNameOtp(token, email.trim());
            setOtpSent(true);
            setBanner({ kind: "info", text: `${message} Enter it below to confirm the change.` });
        } catch (error) {
            setBanner({ kind: "error", text: `Could not send the code: ${(error as Error).message}` });
        } finally {
            setBusy(false);
        }
    }, [getToken, email]);

    const performChange = useCallback(
        async (action: ChangeKey, value: string, code = "") => {
            setBusy(true);
            setBanner(null);
            try {
                const token = getToken();
                if (!token) throw new Error("You're not signed in. Sign in and try again.");

                const message =
                    action === "signin"
                        ? await changeSignInName(token, value, code)
                        : await changePhone(token, value);

                setBanner({ kind: "success", text: message });
                setOpen(null);
                setEmail("");
                setOtp("");
                setOtpSent(false);
                setPhone("");
                setDialCode("+61");

                // The saved value is authoritative from the 200 response — show it
                // directly rather than re-reading Graph, which can lag the write.
                setSummary((prev) =>
                    prev === null
                        ? prev
                        : action === "signin"
                          ? { ...prev, email: value }
                          : { ...prev, phoneNumber: value }
                );
            } catch (error) {
                if (error instanceof AccountApiError && error.code === "mfa_required") {
                    // Native auth can't silently step up MFA — the token is too old
                    // to prove recent MFA. Ask the user to re-authenticate.
                    setBanner({
                        kind: "error",
                        text: "For your security, please sign out and sign in again, then retry this change.",
                    });
                    return;
                }
                if (error instanceof AccountApiError && error.code === "otp_required") {
                    // Code expired / consumed / too many tries — back to "Send code".
                    setOtp("");
                    setOtpSent(false);
                }
                setBanner({ kind: "error", text: `Could not save the change: ${(error as Error).message}` });
            } finally {
                setBusy(false);
            }
        },
        [getToken]
    );

    useEffect(() => {
        void loadSummary();
    }, [loadSummary]);

    const toggle = (key: SectionKey) => {
        setBanner(null);
        // Reset the email-change sub-flow whenever the section is opened/closed.
        setOtp("");
        setOtpSent(false);
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
        <>
            <h2 style={styles.heading}>Manage your sign-in details</h2>
            <p style={styles.lead}>
                Update your password, the email you sign in with, or your multi-factor
                authentication phone number. Changing your sign-in email or phone number requires a
                recent sign-in.
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
                                secure self-service reset. Select the button below, then verify your
                                identity to set a new password.
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
                                disabled={otpSent}
                                onChange={(e) => {
                                    setEmail(e.target.value);
                                    // The code is bound to a specific address —
                                    // editing it restarts the send step.
                                    if (otpSent) {
                                        setOtpSent(false);
                                        setOtp("");
                                    }
                                }}
                            />
                            <p style={styles.hint}>
                                Use the new email the next time you sign in. It must not already be
                                registered to another account. We&rsquo;ll email a verification code
                                to confirm you own this address.
                            </p>

                            {!otpSent ? (
                                <div style={styles.buttonRow}>
                                    <button
                                        type="button"
                                        style={styles.primaryButton}
                                        disabled={busy || email.trim().length === 0}
                                        onClick={sendOtp}
                                    >
                                        {busy ? "Sending…" : "Send verification code"}
                                    </button>
                                </div>
                            ) : (
                                <>
                                    <label style={styles.inputLabel} htmlFor="email-otp">
                                        Verification code
                                    </label>
                                    <input
                                        id="email-otp"
                                        type="text"
                                        inputMode="numeric"
                                        autoComplete="one-time-code"
                                        maxLength={6}
                                        style={styles.input}
                                        value={otp}
                                        placeholder="123456"
                                        onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                                    />
                                    <p style={styles.hint}>
                                        Enter the 6-digit code we emailed to {email.trim()}. This
                                        change requires a recent sign-in.
                                    </p>
                                    <div style={styles.buttonRow}>
                                        <button
                                            type="button"
                                            style={styles.primaryButton}
                                            disabled={busy || otp.trim().length !== 6}
                                            onClick={() => performChange("signin", email.trim(), otp.trim())}
                                        >
                                            {busy ? "Saving…" : "Verify & save email"}
                                        </button>
                                        <button
                                            type="button"
                                            style={styles.toggleButton}
                                            disabled={busy}
                                            onClick={sendOtp}
                                        >
                                            Resend code
                                        </button>
                                    </div>
                                </>
                            )}
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
                            <div style={styles.phoneRow}>
                                <select
                                    aria-label="Country code"
                                    style={styles.dialSelect}
                                    value={dialCode}
                                    onChange={(e) => setDialCode(e.target.value)}
                                >
                                    {DIAL_CODES.map((d) => (
                                        <option key={d.code} value={d.code}>
                                            {d.label}
                                        </option>
                                    ))}
                                </select>
                                <input
                                    id="new-phone"
                                    type="tel"
                                    style={styles.phoneInput}
                                    value={phone}
                                    placeholder="412345678"
                                    autoComplete="tel-national"
                                    onChange={(e) => setPhone(e.target.value)}
                                />
                            </div>
                            <p style={styles.hint}>
                                Select your country code and enter your mobile number without the
                                leading zero (e.g. 412345678).
                            </p>
                            <div style={styles.buttonRow}>
                                <button
                                    type="button"
                                    style={styles.primaryButton}
                                    disabled={busy || toLocalNumber(phone).length === 0}
                                    onClick={() =>
                                        performChange("phone", `${dialCode} ${toLocalNumber(phone)}`)
                                    }
                                >
                                    {busy ? "Saving…" : "Save number"}
                                </button>
                            </div>
                        </>
                    )}
                </>
            )}
        </>
    );
}

export default function AccountPage() {
    const authClient = useAuthClient();
    const [available, setAvailable] = useState(true);
    const [accountData, setAccountData] = useState<CustomAuthAccountData | null>(null);
    const [signedIn, setSignedIn] = useState<boolean | null>(null);

    useEffect(() => setAvailable(accountFeatureAvailable()), []);

    useEffect(() => {
        if (!authClient) return;
        const result = authClient.getCurrentAccount();
        if (result.isCompleted() && result.data) {
            setAccountData(result.data);
            setSignedIn(true);
        } else {
            setSignedIn(false);
        }
    }, [authClient]);

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
                        {!available ? (
                            <>
                                <h2 style={styles.heading}>Account management unavailable</h2>
                                <p style={styles.lead}>
                                    The account self-service features need the local proxy
                                    (<code>npm run cors</code>) and its app-only Graph credential, so
                                    they only run on the dev hosts. They are disabled here.
                                </p>
                            </>
                        ) : signedIn === false ? (
                            <>
                                <h2 style={styles.heading}>Please sign in</h2>
                                <p style={styles.lead}>
                                    You need to be signed in to manage your account details.
                                </p>
                                <Link href="/" style={styles.primaryButton}>
                                    Go to sign in
                                </Link>
                            </>
                        ) : signedIn && accountData ? (
                            <AccountManager accountData={accountData} />
                        ) : null}
                    </div>
                </div>
            </div>
        </main>
    );
}
