"use client";

import { useMsal } from "@azure/msal-react";
import { InteractionStatus } from "@azure/msal-browser";
import { loginRequest } from "@/config/auth-config";

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
    content: { maxWidth: "36rem", margin: "0 auto" },
    heading: { fontSize: "1.875rem", fontWeight: 700, margin: "0 0 0.75rem 0" },
    lead: { fontSize: "1rem", margin: "0 0 1.5rem 0", lineHeight: 1.6 },
    steps: { margin: "0 0 1.5rem 1.25rem", lineHeight: 1.8 },
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

/**
 * Entra External ID has no separate "password reset" policy/authority the way
 * B2C did (B2C_1A_PasswordReset). Self-service password reset is built into the
 * sign-up/sign-in user flow as the "Forgot password?" link on the hosted sign-in
 * page. So this page simply routes the user into that hosted flow.
 */
export default function ResetPasswordPage() {
    const { instance, inProgress } = useMsal();
    const busy = inProgress !== InteractionStatus.None;

    return (
        <main style={styles.page}>
            <div style={styles.hero}>
                <div style={styles.heroInner}>
                    <h1 style={styles.heroTitle}>Reset your password</h1>
                </div>
            </div>
            <div style={styles.cardWrap}>
                <div style={styles.card}>
                    <div style={styles.content}>
                    <h2 style={styles.heading}>Forgot your password?</h2>
                    <p style={styles.lead}>
                        You can reset your password from the secure Service Tasmania sign-in page. Select the button
                        below, then on the sign-in page:
                    </p>
                    <ol style={styles.steps}>
                        <li>Enter your email address.</li>
                        <li>
                            Select <strong>Forgot my password</strong>
                        </li>
                        <li>Verify your identity with the emailed code and choose a new password.</li>
                    </ol>
                    <button
                        style={styles.primaryButton}
                        onClick={() => instance.loginRedirect(loginRequest)}
                        disabled={busy}
                    >
                        Go to sign-in page
                    </button>
                    </div>
                </div>
            </div>
        </main>
    );
}
