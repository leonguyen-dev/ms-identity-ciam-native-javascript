import { AuthClientProvider } from "@/auth/AuthClientProvider";

/**
 * The custom-auth (native authentication) client is only needed by the sign-up
 * flow, so its provider wraps this route alone rather than the whole app — the
 * rest of the app stays purely browser-delegated (MSAL redirect).
 */
export default function SignUpLayout({ children }: { children: React.ReactNode }) {
    return <AuthClientProvider>{children}</AuthClientProvider>;
}
