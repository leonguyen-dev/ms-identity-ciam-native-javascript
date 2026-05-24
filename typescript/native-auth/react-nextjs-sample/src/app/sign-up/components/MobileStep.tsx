import { useState } from "react";
import { styles } from "../styles/styles";
import type { MobileStepProps } from "../types/formProperties";
import { ErrorSummary, FieldError, type FormError } from "@/app/shared/components/FormErrors";

const FIELD_ID = "signup-mobile";
const MOBILE_REGEX = /^\+?[0-9\s\-()]{7,20}$/;

export function MobileStep({ onSubmit, mobileNumber, setMobileNumber, loading }: MobileStepProps) {
    const [submitted, setSubmitted] = useState(false);

    const trimmed = mobileNumber.trim();
    const fieldErrorMessage = !trimmed
        ? "Please enter your mobile number."
        : !MOBILE_REGEX.test(trimmed)
          ? "Please enter a valid mobile number."
          : null;

    const showError = submitted && fieldErrorMessage !== null;

    const errors: FormError[] = showError
        ? [
              { id: FIELD_ID, message: fieldErrorMessage as string },
              { message: "One or more fields are filled out incorrectly. Please check your entries and try again." },
          ]
        : [];

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitted(true);
        if (fieldErrorMessage !== null) return;
        onSubmit(e);
    };

    return (
        <form onSubmit={handleSubmit} style={styles.form} noValidate>
            <h2 style={styles.stepHeading}>Add your mobile number</h2>

            <ErrorSummary errors={errors} />

            <label htmlFor={FIELD_ID} style={styles.label}>
                Mobile number
            </label>
            <input
                id={FIELD_ID}
                type="tel"
                placeholder="+1234567890"
                value={mobileNumber}
                onChange={(e) => setMobileNumber(e.target.value)}
                style={styles.input}
                autoFocus
                aria-invalid={showError}
                aria-describedby={showError ? `${FIELD_ID}-error` : undefined}
            />
            {showError && <FieldError id={`${FIELD_ID}-error`} message={fieldErrorMessage as string} />}

            <button type="submit" style={loading ? styles.buttonDisabled : styles.button} disabled={loading}>
                {loading ? "Sending..." : "Send verification code"}
            </button>
        </form>
    );
}
