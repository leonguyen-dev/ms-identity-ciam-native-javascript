import { useState } from "react";
import { styles } from "../styles/styles";
import type { MobileStepProps } from "../types/formProperties";
import { ErrorSummary, FieldError, type FormError } from "@/app/shared/components/FormErrors";

const FIELD_ID = "signup-mobile";
const MOBILE_REGEX = /^[0-9\s\-()]{6,15}$/;

const DIAL_CODES = [
    { code: "+61", label: "Australia (+61)" },
    { code: "+64", label: "New Zealand (+64)" },
];

export function MobileStep({
    onSubmit,
    mobileNumber,
    setMobileNumber,
    dialCode,
    setDialCode,
    loading,
    onCancel,
}: MobileStepProps) {
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
            <h2 style={styles.stepHeading}>Add your mobile number (3/3)</h2>

            <ErrorSummary errors={errors} />

            <label htmlFor={FIELD_ID} style={styles.label}>
                Mobile number
            </label>
            <div style={styles.mobileRow}>
                <select
                    aria-label="Country code"
                    value={dialCode}
                    onChange={(e) => setDialCode(e.target.value)}
                    style={styles.dialSelect}
                >
                    {DIAL_CODES.map((d) => (
                        <option key={d.code} value={d.code}>
                            {d.label}
                        </option>
                    ))}
                </select>
                <input
                    id={FIELD_ID}
                    type="tel"
                    placeholder="Enter mobile number"
                    value={mobileNumber}
                    onChange={(e) => setMobileNumber(e.target.value)}
                    style={styles.mobileInput}
                    autoFocus
                    aria-invalid={showError}
                    aria-describedby={showError ? `${FIELD_ID}-error` : undefined}
                />
            </div>
            {showError && <FieldError id={`${FIELD_ID}-error`} message={fieldErrorMessage as string} />}

            <div style={styles.guideBox}>
                <div style={styles.guideTitle}>Mobile number guide</div>
                <ul style={styles.guideList}>
                    <li>Enter your mobile number for more protection to your account.</li>
                    <li>We will send a confirmation code to your mobile phone each time you log in.</li>
                    <li>You can manage multi-factor authentication from your account once you have logged in.</li>
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
