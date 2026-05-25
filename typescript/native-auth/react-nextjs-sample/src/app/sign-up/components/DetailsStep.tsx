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

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 20;
const STANDARD_SYMBOLS = "!@#$%^&*()-_=+[]{};:'\",.<>/?\\|`~";
const ALLOWED_PASSWORD_CHARS = new RegExp(
    `^[A-Za-z0-9${STANDARD_SYMBOLS.replace(/[\\\]^]/g, "\\$&")}]+$`
);

const PASSWORD_GUIDE_ERROR = "Your password does not meet the requirements of the password guide";
const CONFIRM_PASSWORD_GUIDE_ERROR =
    "Your password confirmation does not meet the requirements of the password guide";
const OTHER_FIELDS_ERROR =
    "One or more fields are filled out incorrectly. Please check your entries and try again.";

function isPasswordValid(password: string): boolean {
    if (password.length === 0) return false;
    if (/\s/.test(password)) return false;
    if (!ALLOWED_PASSWORD_CHARS.test(password)) return false;
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) return false;
    const categories = [/[a-z]/, /[A-Z]/, /[0-9]/, new RegExp(`[${STANDARD_SYMBOLS.replace(/[\\\]^]/g, "\\$&")}]`)];
    const matched = categories.filter((re) => re.test(password)).length;
    return matched >= 3;
}

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
    onCancel,
}: DetailsStepProps) {
    const [submitted, setSubmitted] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);

    const passwordInvalid = !isPasswordValid(password);
    const confirmInvalid = confirmPassword.length === 0 || password !== confirmPassword;

    const fieldErrors: Record<string, string | null> = {
        [FIELD_IDS.password]: passwordInvalid ? PASSWORD_GUIDE_ERROR : null,
        [FIELD_IDS.confirmPassword]: confirmInvalid ? CONFIRM_PASSWORD_GUIDE_ERROR : null,
        [FIELD_IDS.givenName]: givenName.trim().length === 0 ? "Please provide your given name(s)" : null,
        [FIELD_IDS.familyName]: familyName.trim().length === 0 ? "Please provide family name" : null,
        [FIELD_IDS.dateOfBirth]: dateOfBirth.length === 0 ? "Please provide your date of birth" : null,
        [FIELD_IDS.terms]: !termsAccepted ? "You must agree to the terms and conditions" : null,
    };

    const canSubmit = Object.values(fieldErrors).every((e) => e === null);

    const OTHER_FIELD_KEYS = ["givenName", "familyName", "dateOfBirth", "terms"] as const;
    const otherFieldsInvalid = OTHER_FIELD_KEYS.some((key) => fieldErrors[FIELD_IDS[key]] !== null);

    const summaryErrors: FormError[] = [];
    if (submitted && !canSubmit) {
        if (passwordInvalid) {
            summaryErrors.push({ id: FIELD_IDS.password, message: PASSWORD_GUIDE_ERROR });
        }
        if (confirmInvalid) {
            summaryErrors.push({ id: FIELD_IDS.confirmPassword, message: CONFIRM_PASSWORD_GUIDE_ERROR });
        }
        for (const key of OTHER_FIELD_KEYS) {
            const id = FIELD_IDS[key];
            const message = fieldErrors[id];
            if (message) summaryErrors.push({ id, message });
        }
        if (otherFieldsInvalid) {
            summaryErrors.push({ message: OTHER_FIELDS_ERROR });
        }
    }

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
            <h2 style={styles.stepHeading}>Enter your details (2/3)</h2>

            <ErrorSummary errors={summaryErrors} />

            <label htmlFor={FIELD_IDS.password} style={styles.label}>
                Password
            </label>
            <div style={styles.inputWrapper}>
                <input
                    id={FIELD_IDS.password}
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={styles.inputWithToggle}
                    aria-invalid={!!showFieldError(FIELD_IDS.password)}
                />
                <button
                    type="button"
                    style={styles.showToggle}
                    onClick={() => setShowPassword((v) => !v)}
                    aria-pressed={showPassword}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                >
                    {showPassword ? "Hide" : "Show"}
                </button>
            </div>
            {showFieldError(FIELD_IDS.password) && (
                <FieldError message={showFieldError(FIELD_IDS.password) as string} />
            )}

            <div style={styles.guideBox}>
                <div style={styles.guideTitle}>Password guide</div>
                <ul style={styles.guideList}>
                    <li>Your password must be between 8 and 20 characters.</li>
                    <li>
                        Your password must include at least 3 of the following: lowercase letters, uppercase letters,
                        numbers, symbols.
                    </li>
                    <li>Cannot contain spaces or non-standard symbols.</li>
                </ul>
            </div>

            <label htmlFor={FIELD_IDS.confirmPassword} style={styles.label}>
                Confirm password
            </label>
            <div style={styles.inputWrapper}>
                <input
                    id={FIELD_IDS.confirmPassword}
                    type={showConfirmPassword ? "text" : "password"}
                    placeholder="Re-enter your password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    style={styles.inputWithToggle}
                    aria-invalid={!!showFieldError(FIELD_IDS.confirmPassword)}
                />
                <button
                    type="button"
                    style={styles.showToggle}
                    onClick={() => setShowConfirmPassword((v) => !v)}
                    aria-pressed={showConfirmPassword}
                    aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                >
                    {showConfirmPassword ? "Hide" : "Show"}
                </button>
            </div>
            {showFieldError(FIELD_IDS.confirmPassword) && (
                <FieldError message={showFieldError(FIELD_IDS.confirmPassword) as string} />
            )}

            <label htmlFor={FIELD_IDS.givenName} style={styles.label}>
                Given name(s)
            </label>
            <input
                id={FIELD_IDS.givenName}
                type="text"
                placeholder="Enter your given name(s) as they appear on your ID"
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
                placeholder="Enter your family name as it appears on your ID"
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
                placeholder="dd/mm/yyyy"
                value={dateOfBirth}
                onChange={(e) => setDateOfBirth(e.target.value)}
                style={styles.input}
                aria-invalid={!!showFieldError(FIELD_IDS.dateOfBirth)}
            />
            {showFieldError(FIELD_IDS.dateOfBirth) && (
                <FieldError message={showFieldError(FIELD_IDS.dateOfBirth) as string} />
            )}

            <div style={styles.termsQuestion}>
                Do you agree to the{" "}
                <a href="/terms" target="_blank" rel="noopener noreferrer" style={styles.termsLink}>
                    terms and conditions?
                </a>
            </div>
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

            <div style={styles.actionsRow}>
                <button type="submit" style={loading ? styles.buttonDisabled : styles.button} disabled={loading}>
                    {loading ? "Working..." : "Next"}
                </button>
                <button type="button" className="st-cancel-button" onClick={onCancel}>
                    Cancel
                </button>
            </div>
        </form>
    );
}
