import { styles } from "../styles/styles";
import type { VerifyIdentityStepProps } from "../types/formProperties";

export function VerifyIdentityStep({ onSubmit, onCancel, loading, maskedMobile }: VerifyIdentityStepProps) {
    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSubmit(e);
    };

    return (
        <form onSubmit={handleSubmit} style={styles.form} noValidate>
            <h2 style={styles.stepHeading}>Verify your identity (3/5)</h2>

            <div style={styles.identityText}>
                {maskedMobile ? (
                    <>
                        We have the following mobile number <strong>{maskedMobile}</strong>
                    </>
                ) : (
                    <>We will send a verification code to your mobile number.</>
                )}
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
