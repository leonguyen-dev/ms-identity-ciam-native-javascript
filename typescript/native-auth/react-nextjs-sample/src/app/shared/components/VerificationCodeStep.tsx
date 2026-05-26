import { useState } from "react";
import type { ReactNode } from "react";
import { ErrorSummary, FieldError, type FormError } from "./FormErrors";
import { authFlowStyles as defaultStyles, type AuthFlowStyles } from "../styles/authFlowStyles";

interface VerificationCodeStepProps {
    onSubmit: (e: React.FormEvent) => void;
    code: string;
    setCode: (value: string) => void;
    loading: boolean;
    onCancel: () => void;
    onResend: () => void;
    fieldId: string;
    heading: string;
    sentMessage: ReactNode;
    resendPrompt: string;
    serverError?: string;
    expectedCodeLength?: number;
    defaultCodeLength?: number;
    placeholder?: string;
    submitButtonText?: string;
    submitButtonLoadingText?: string;
    emptyCodeMessage?: string;
    invalidCodeMessage?: string;
    styles?: AuthFlowStyles;
}

export function VerificationCodeStep({
    onSubmit,
    code,
    setCode,
    loading,
    onCancel,
    onResend,
    fieldId,
    heading,
    sentMessage,
    resendPrompt,
    serverError,
    expectedCodeLength,
    defaultCodeLength = 8,
    placeholder = "Enter your code",
    submitButtonText = "Next",
    submitButtonLoadingText = "Working...",
    emptyCodeMessage,
    invalidCodeMessage = "That code is incorrect. Please try again.",
    styles = defaultStyles,
}: VerificationCodeStepProps) {
    const [submitted, setSubmitted] = useState(false);

    const trimmed = code.trim();
    const requiredLength = expectedCodeLength && expectedCodeLength > 0 ? expectedCodeLength : defaultCodeLength;
    const isValid = trimmed.length === requiredLength && /^\d+$/.test(trimmed);
    const clientErrorMessage = !trimmed && emptyCodeMessage ? emptyCodeMessage : invalidCodeMessage;

    const showClientError = submitted && !isValid;
    const activeFieldMessage = showClientError ? clientErrorMessage : serverError ?? "";
    const showFieldError = Boolean(activeFieldMessage);

    const errors: FormError[] = showClientError
        ? [{ id: fieldId, message: clientErrorMessage }]
        : serverError
          ? [{ id: fieldId, message: serverError }]
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

            <div style={styles.sentBanner}>{sentMessage}</div>

            <label htmlFor={fieldId} style={styles.label}>
                Code
            </label>
            <input
                id={fieldId}
                type="text"
                inputMode="numeric"
                placeholder={placeholder}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                style={styles.input}
                autoFocus
                aria-invalid={showFieldError}
                aria-describedby={showFieldError ? `${fieldId}-error` : undefined}
            />
            {showFieldError && <FieldError id={`${fieldId}-error`} message={activeFieldMessage} />}

            <div style={styles.actionsRow}>
                <button type="submit" style={loading ? styles.buttonDisabled : styles.button} disabled={loading}>
                    {loading ? submitButtonLoadingText : submitButtonText}
                </button>
                <button type="button" className="st-cancel-button" onClick={onCancel}>
                    Cancel
                </button>
            </div>

            <div style={styles.resendLine}>
                {resendPrompt}{" "}
                <button
                    type="button"
                    className="st-text-button"
                    style={styles.resendButton}
                    onClick={onResend}
                    disabled={loading}
                >
                    Resend the code
                </button>
            </div>
        </form>
    );
}