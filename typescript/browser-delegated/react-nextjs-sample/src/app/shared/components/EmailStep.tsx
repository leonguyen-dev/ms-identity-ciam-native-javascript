import { useState } from "react";
import type { ReactNode } from "react";
import { ErrorSummary, FieldError, type FormError } from "./FormErrors";
import { authFlowStyles as defaultStyles, type AuthFlowStyles } from "../styles/authFlowStyles";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface EmailStepProps {
    onSubmit: (e: React.FormEvent) => void;
    email: string;
    setEmail: (value: string) => void;
    loading: boolean;
    onCancel: () => void;
    fieldId: string;
    heading: string;
    serverError?: string;
    guideTitle?: string;
    guideItems?: ReactNode[];
    styles?: AuthFlowStyles;
}

export function EmailStep({
    onSubmit,
    email,
    setEmail,
    loading,
    onCancel,
    fieldId,
    heading,
    serverError,
    guideTitle,
    guideItems,
    styles = defaultStyles,
}: EmailStepProps) {
    const [submitted, setSubmitted] = useState(false);
    const isValid = EMAIL_REGEX.test(email);
    const showClientError = submitted && !isValid;
    const showServerError = Boolean(serverError) && !showClientError;
    const hasError = showClientError || showServerError;

    const errors: FormError[] = showClientError
        ? [{ id: fieldId, message: "Please enter a valid email address." }]
        : [];

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitted(true);
        if (!isValid) return;
        onSubmit(e);
    };

    return (
        <form onSubmit={handleSubmit} style={styles.form} noValidate>
            <h2 style={styles.stepHeading}>{heading}</h2>

            <ErrorSummary errors={errors} />

            {showServerError && (
                <div style={styles.inlineError} role="alert" id={`${fieldId}-server-error`}>
                    {serverError}
                </div>
            )}

            <label htmlFor={fieldId} style={styles.label}>
                Email address
            </label>
            <input
                id={fieldId}
                type="email"
                placeholder="Enter your email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={hasError ? styles.inputError : styles.input}
                autoFocus
                aria-invalid={hasError}
                aria-describedby={
                    showClientError ? `${fieldId}-error` : showServerError ? `${fieldId}-server-error` : undefined
                }
            />
            {showClientError && (
                <div id={`${fieldId}-error`}>
                    <FieldError message="Please enter a valid email address." />
                </div>
            )}

            {guideItems && guideItems.length > 0 && (
                <div style={styles.guideBox}>
                    {guideTitle && <div style={styles.guideTitle}>{guideTitle}</div>}
                    <ul style={styles.guideList}>
                        {guideItems.map((item, index) => (
                            <li key={index}>{item}</li>
                        ))}
                    </ul>
                </div>
            )}

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