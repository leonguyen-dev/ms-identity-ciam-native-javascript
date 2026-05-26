import { useState } from "react";
import { styles } from "../styles/styles";
import type { SmsCodeStepProps } from "../types/formProperties";
import { ErrorSummary, FieldError, type FormError } from "@/app/shared/components/FormErrors";

const FIELD_ID = "signup-sms-code";

export function SmsCodeStep({
    onSubmit,
    code,
    setCode,
    loading,
    onCancel,
    onResend,
    mobileNumber,
    serverError,
    expectedCodeLength,
    stepIndicator,
}: SmsCodeStepProps) {
    const [submitted, setSubmitted] = useState(false);

    const trimmed = code.trim();
    const requiredLength = expectedCodeLength && expectedCodeLength > 0 ? expectedCodeLength : 6;
    const isValid = trimmed.length === requiredLength && /^\d+$/.test(trimmed);
    const clientErrorMessage = !trimmed
        ? "Please enter the verification code you received."
        : "That code is incorrect. Please try again.";

    const showClientError = submitted && !isValid;
    const activeFieldMessage = showClientError ? clientErrorMessage : serverError ?? "";
    const showFieldError = Boolean(activeFieldMessage);

    const errors: FormError[] = showClientError
        ? [{ id: FIELD_ID, message: clientErrorMessage }]
        : serverError
          ? [{ id: FIELD_ID, message: serverError }]
          : [];

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitted(true);
        if (!isValid) return;
        onSubmit(e);
    };

    return (
        <form onSubmit={handleSubmit} style={styles.form} noValidate>
            <h2 style={styles.stepHeading}>
                Enter your code{stepIndicator ? ` (${stepIndicator})` : ""}
            </h2>

            <ErrorSummary errors={errors} />

            <div style={styles.sentBanner}>
                We sent a code to <strong>{mobileNumber}</strong>
            </div>

            <label htmlFor={FIELD_ID} style={styles.label}>
                Code
            </label>
            <input
                id={FIELD_ID}
                type="text"
                inputMode="numeric"
                placeholder="Verification code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                style={styles.input}
                autoFocus
                aria-invalid={showFieldError}
                aria-describedby={showFieldError ? `${FIELD_ID}-error` : undefined}
            />
            {showFieldError && <FieldError id={`${FIELD_ID}-error`} message={activeFieldMessage} />}

            <div style={styles.actionsRow}>
                <button type="submit" style={loading ? styles.buttonDisabled : styles.button} disabled={loading}>
                    {loading ? "Verifying..." : "Verify code"}
                </button>
                <button type="button" className="st-cancel-button" onClick={onCancel}>
                    Cancel
                </button>
            </div>

            <div style={styles.resendLine}>
                Haven&apos;t got an SMS from us?{" "}
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
