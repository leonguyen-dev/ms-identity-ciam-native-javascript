import { useState } from "react";
import { styles } from "../styles/styles";
import type { ResetNewPasswordStepProps } from "../types/formProperties";
import { ErrorSummary, FieldError, type FormError } from "@/app/shared/components/FormErrors";
import {
    CONFIRM_PASSWORD_GUIDE_ERROR,
    PASSWORD_GUIDE_ERROR,
    isPasswordValid,
} from "@/app/shared/utils/passwordValidation";

const FIELD_IDS = {
    password: "reset-password",
    confirmPassword: "reset-confirm-password",
} as const;


export function NewPasswordForm({
    onSubmit,
    password,
    setPassword,
    confirmPassword,
    setConfirmPassword,
    loading,
    onCancel,
    serverError,
}: ResetNewPasswordStepProps) {
    const [submitted, setSubmitted] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);

    const passwordInvalid = !isPasswordValid(password);
    const confirmInvalid = confirmPassword.length === 0 || password !== confirmPassword;

    const fieldErrors: Record<string, string | null> = {
        [FIELD_IDS.password]: passwordInvalid ? PASSWORD_GUIDE_ERROR : null,
        [FIELD_IDS.confirmPassword]: confirmInvalid ? CONFIRM_PASSWORD_GUIDE_ERROR : null,
    };

    const canSubmit = Object.values(fieldErrors).every((e) => e === null);

    const summaryErrors: FormError[] = [];
    if (submitted && !canSubmit) {
        if (passwordInvalid) {
            summaryErrors.push({ id: FIELD_IDS.password, message: PASSWORD_GUIDE_ERROR });
        }
        if (confirmInvalid) {
            summaryErrors.push({ id: FIELD_IDS.confirmPassword, message: CONFIRM_PASSWORD_GUIDE_ERROR });
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
            <h2 style={styles.stepHeading}>Enter your new password (5/5)</h2>

            <ErrorSummary errors={summaryErrors} />

            {serverError && (
                <div style={styles.inlineError} role="alert">
                    {serverError}
                </div>
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

            <label htmlFor={FIELD_IDS.password} style={styles.label}>
                New password
            </label>
            <div style={styles.inputWrapper}>
                <input
                    id={FIELD_IDS.password}
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter your new password"
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

            <label htmlFor={FIELD_IDS.confirmPassword} style={styles.label}>
                Confirm new password
            </label>
            <div style={styles.inputWrapper}>
                <input
                    id={FIELD_IDS.confirmPassword}
                    type={showConfirmPassword ? "text" : "password"}
                    placeholder="Confirm your new password"
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

            <div style={styles.actionsRow}>
                <button type="submit" style={loading ? styles.buttonDisabled : styles.button} disabled={loading}>
                    {loading ? "Changing..." : "Change password"}
                </button>
                <button type="button" className="st-cancel-button" onClick={onCancel}>
                    Cancel
                </button>
            </div>
        </form>
    );
}
