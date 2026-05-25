import { useState } from "react";
import { styles } from "../styles/styles";
import type { DetailsStepProps } from "../types/formProperties";
import { ErrorSummary, FieldError, type FormError } from "@/app/shared/components/FormErrors";

const FIELD_IDS = {
    password: "signup-password",
    confirmPassword: "signup-confirm-password",
    givenName: "signup-given-name",
    familyName: "signup-family-name",
    dateOfBirth: "signup-dob",
    terms: "signup-terms",
} as const;

export function DetailsStep({
    onSubmit,
    password,
    setPassword,
    confirmPassword,
    setConfirmPassword,
    givenName,
    setGivenName,
    familyName,
    setFamilyName,
    dateOfBirth,
    setDateOfBirth,
    termsAccepted,
    setTermsAccepted,
    loading,
}: DetailsStepProps) {
    const [submitted, setSubmitted] = useState(false);

    const fieldErrors: Record<string, string | null> = {
        [FIELD_IDS.password]: password.length === 0 ? "Please enter a password." : null,
        [FIELD_IDS.confirmPassword]:
            confirmPassword.length === 0
                ? "Please confirm your password."
                : password !== confirmPassword
                  ? "Passwords do not match."
                  : null,
        [FIELD_IDS.givenName]: givenName.trim().length === 0 ? "Please enter your given name." : null,
        [FIELD_IDS.familyName]: familyName.trim().length === 0 ? "Please enter your family name." : null,
        [FIELD_IDS.dateOfBirth]: dateOfBirth.length === 0 ? "Please enter your date of birth." : null,
        [FIELD_IDS.terms]: !termsAccepted ? "You must agree to the terms and conditions." : null,
    };

    const canSubmit = Object.values(fieldErrors).every((e) => e === null);

    const summaryErrors: FormError[] = submitted && !canSubmit
        ? [
              ...Object.entries(fieldErrors)
                  .filter(([, message]) => message !== null)
                  .map(([id, message]) => ({ id, message: message as string })),
              { message: "One or more fields are filled out incorrectly. Please check your entries and try again." },
          ]
        : [];

    const showFieldError = (id: string): string | null =>
        submitted && fieldErrors[id] ? fieldErrors[id] : null;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitted(true);
        if (!canSubmit) return;
        onSubmit(e);
    };

    return (
        <form onSubmit={handleSubmit} style={styles.form} noValidate>
            <h2 style={styles.stepHeading}>Enter your details</h2>

            <ErrorSummary errors={summaryErrors} />

            <label htmlFor={FIELD_IDS.password} style={styles.label}>
                Password
            </label>
            <input
                id={FIELD_IDS.password}
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={styles.input}
                aria-invalid={!!showFieldError(FIELD_IDS.password)}
            />
            {showFieldError(FIELD_IDS.password) && (
                <FieldError message={showFieldError(FIELD_IDS.password) as string} />
            )}

            <label htmlFor={FIELD_IDS.confirmPassword} style={styles.label}>
                Confirm password
            </label>
            <input
                id={FIELD_IDS.confirmPassword}
                type="password"
                placeholder="Confirm password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                style={styles.input}
                aria-invalid={!!showFieldError(FIELD_IDS.confirmPassword)}
            />
            {showFieldError(FIELD_IDS.confirmPassword) && (
                <FieldError message={showFieldError(FIELD_IDS.confirmPassword) as string} />
            )}

            <label htmlFor={FIELD_IDS.givenName} style={styles.label}>
                Given name
            </label>
            <input
                id={FIELD_IDS.givenName}
                type="text"
                placeholder="Given name"
                value={givenName}
                onChange={(e) => setGivenName(e.target.value)}
                style={styles.input}
                aria-invalid={!!showFieldError(FIELD_IDS.givenName)}
            />
            {showFieldError(FIELD_IDS.givenName) && (
                <FieldError message={showFieldError(FIELD_IDS.givenName) as string} />
            )}

            <label htmlFor={FIELD_IDS.familyName} style={styles.label}>
                Family name
            </label>
            <input
                id={FIELD_IDS.familyName}
                type="text"
                placeholder="Family name"
                value={familyName}
                onChange={(e) => setFamilyName(e.target.value)}
                style={styles.input}
                aria-invalid={!!showFieldError(FIELD_IDS.familyName)}
            />
            {showFieldError(FIELD_IDS.familyName) && (
                <FieldError message={showFieldError(FIELD_IDS.familyName) as string} />
            )}

            <label htmlFor={FIELD_IDS.dateOfBirth} style={styles.label}>
                Date of birth (DD/MM/YYYY)
            </label>
            <input
                id={FIELD_IDS.dateOfBirth}
                type="date"
                value={dateOfBirth}
                onChange={(e) => setDateOfBirth(e.target.value)}
                style={styles.input}
                aria-invalid={!!showFieldError(FIELD_IDS.dateOfBirth)}
            />
            {showFieldError(FIELD_IDS.dateOfBirth) && (
                <FieldError message={showFieldError(FIELD_IDS.dateOfBirth) as string} />
            )}

            <label style={styles.checkboxLabel}>
                <input
                    id={FIELD_IDS.terms}
                    type="checkbox"
                    checked={termsAccepted}
                    onChange={(e) => setTermsAccepted(e.target.checked)}
                    aria-invalid={!!showFieldError(FIELD_IDS.terms)}
                />
                <span>I agree to the terms and conditions</span>
            </label>
            {showFieldError(FIELD_IDS.terms) && (
                <FieldError message={showFieldError(FIELD_IDS.terms) as string} />
            )}

            <button type="submit" style={loading ? styles.buttonDisabled : styles.button} disabled={loading}>
                {loading ? "Working..." : "Next"}
            </button>
        </form>
    );
}
