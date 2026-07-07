// Trimmed from the native-auth sample: only the props the ported sign-up flow
// uses. The full native sample also defines password/code/MFA form props for
// its in-app sign-in flow, which this app deliberately does not have — sign-in
// stays on the Entra-hosted pages.
export interface FormProps {
    loading: boolean;
}
