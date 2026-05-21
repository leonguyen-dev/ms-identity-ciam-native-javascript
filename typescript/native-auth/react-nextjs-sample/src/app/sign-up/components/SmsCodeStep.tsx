import { styles } from "../styles/styles";
import type { SmsCodeStepProps } from "../types/formProperties";

export function SmsCodeStep({ onSubmit, code, setCode, loading }: SmsCodeStepProps) {
    return (
        <form onSubmit={onSubmit} style={styles.form}>
            <label style={styles.label}>Enter SMS verification code</label>
            <input
                type="text"
                inputMode="numeric"
                placeholder="Verification code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                style={styles.input}
                autoFocus
                required
            />
            <button
                type="submit"
                style={loading || !code ? styles.buttonDisabled : styles.button}
                disabled={loading || !code}
            >
                {loading ? "Verifying..." : "Verify code"}
            </button>
        </form>
    );
}
