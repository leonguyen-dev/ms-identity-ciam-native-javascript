import { useState } from "react";
import { styles } from "../styles/styles";
import type { SmsCodeStepProps } from "../types/formProperties";
import { ErrorSummary, FieldError, type FormError } from "@/app/shared/components/FormErrors";

const FIELD_ID = "signup-sms-code";

export function SmsCodeStep({ onSubmit, code, setCode, loading, onCancel }: SmsCodeStepProps) {
    const [submitted, setSubmitted] = useState(false);

    const trimmed = code.trim();
    const isValid = trimmed.length >= 6 && /^\d+$/.test(trimmed);
    const showError = submitted && !isValid;

    const fieldErrorMessage = !trimmed
        ? "Please enter the SMS verification code."
        : "Please enter a valid SMS verification code.";

    const errors: FormError[] = showError
        ? [
              { id: FIELD_ID, message: fieldErrorMessage },
              { message: "One or more fields are filled out incorrectly. Please check your entries and try again." },
          ]
        : [];

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitted(true);
        if (!isValid) return;
        onSubmit(e);
    };

    return (
        <form onSubmit={handleSubmit} style={styles.form} noValidate>
            <h2 style={styles.stepHeading}>Enter SMS verification code</h2>

            <ErrorSummary errors={errors} />

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
                aria-invalid={showError}
                aria-describedby={showError ? `${FIELD_ID}-error` : undefined}
            />
            {showError && <FieldError id={`${FIELD_ID}-error`} message={fieldErrorMessage} />}

            <div style={styles.actionsRow}>
                <button type="submit" style={loading ? styles.buttonDisabled : styles.button} disabled={loading}>
                    {loading ? "Verifying..." : "Verify code"}
                </button>
                <button type="button" className="st-cancel-button" onClick={onCancel}>
                    Cancel
                </button>
            </div>
        </form>
    );
}
