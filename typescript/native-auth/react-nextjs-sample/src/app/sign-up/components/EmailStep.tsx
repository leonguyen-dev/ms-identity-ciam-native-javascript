import { useState } from "react";
import { styles } from "../styles/styles";
import type { EmailStepProps } from "../types/formProperties";
import { ErrorSummary, FieldError, type FormError } from "@/app/shared/components/FormErrors";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_FIELD_ID = "signup-email";

export function EmailStep({ onSubmit, email, setEmail, loading, onCancel, serverError }: EmailStepProps) {
    const [submitted, setSubmitted] = useState(false);
    const isValid = EMAIL_REGEX.test(email);
    const showClientError = submitted && !isValid;
    const showServerError = Boolean(serverError) && !showClientError;
    const hasError = showClientError || showServerError;

    const errors: FormError[] = showClientError
        ? [{ id: EMAIL_FIELD_ID, message: "Please enter a valid email address." }]
        : [];

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitted(true);
        if (!isValid) return;
        onSubmit(e);
    };

    return (
        <form onSubmit={handleSubmit} style={styles.form} noValidate>
            <h2 style={styles.stepHeading}>Enter your email address (1/3)</h2>

            <ErrorSummary errors={errors} />

            {showServerError && (
                <div style={styles.inlineError} role="alert" id={`${EMAIL_FIELD_ID}-server-error`}>
                    {serverError}
                </div>
            )}

            <label htmlFor={EMAIL_FIELD_ID} style={styles.label}>
                Email address
            </label>
            <input
                id={EMAIL_FIELD_ID}
                type="email"
                placeholder="Enter your email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={hasError ? styles.inputError : styles.input}
                autoFocus
                aria-invalid={hasError}
                aria-describedby={
                    showClientError
                        ? `${EMAIL_FIELD_ID}-error`
                        : showServerError
                          ? `${EMAIL_FIELD_ID}-server-error`
                          : undefined
                }
            />
            {showClientError && (
                <div id={`${EMAIL_FIELD_ID}-error`}>
                    <FieldError message="Please enter a valid email address." />
                </div>
            )}

            <div style={styles.guideBox}>
                <div style={styles.guideTitle}>Email address guide</div>
                <ul style={styles.guideList}>
                    <li>Enter the email address you will use to sign in to your myServiceTas account.</li>
                    <li>We will email you a code which you will have to enter on the next screen.</li>
                    <li>
                        You cannot use a school email address or one you share with someone else. An email address can
                        only be used for one account.
                    </li>
                </ul>
            </div>

            <div style={styles.actionsRow}>
                <button type="submit" style={loading ? styles.buttonDisabled : styles.button} disabled={loading}>
                    {loading ? "Sending..." : "Send verification code"}
                </button>
                <button type="button" className="st-cancel-button" onClick={onCancel}>
                    Cancel
                </button>
            </div>
        </form>
    );
}
