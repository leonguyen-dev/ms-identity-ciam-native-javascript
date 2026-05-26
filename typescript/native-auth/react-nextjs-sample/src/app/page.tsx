"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
    AuthFlowStateBase,
    AuthMethodRegistrationRequiredState,
    AuthMethodVerificationRequiredState,
    AuthenticationMethod,
    CustomAuthAccountData,
    MfaAwaitingState,
    MfaVerificationRequiredState,
    SignInCodeRequiredState,
    SignInCompletedState,
    SignInPasswordRequiredState,
} from "@azure/msal-browser/custom-auth";
import { PopupRequest } from "@azure/msal-browser";
import { useAuthClient } from "@/auth/AuthClientProvider";
import { customAuthConfig } from "../config/auth-config";
import { PasswordForm } from "./shared/components/PasswordForm";
import { CodeForm } from "./shared/components/CodeForm";
import { MobileStep } from "./sign-up/components/MobileStep";
import { SmsCodeStep } from "./sign-up/components/SmsCodeStep";
import { styles as signUpStyles } from "./sign-up/styles/styles";
import { friendlyAuthError, isContinuationTokenExpired } from "./shared/utils/friendlyAuthError";
import { normalizeMobile, toLocalNumber } from "./shared/utils/formatMobile";

const styles = {
    page: {
        backgroundColor: "#f5f5f5",
        minHeight: "calc(100vh - 3.75rem)",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        color: "#292929",
    },
    hero: {
        backgroundColor: "#098851",
        padding: "3.75rem 0",
    },
    heroInner: {
        maxWidth: "80rem",
        margin: "0 auto",
    },
    heroTitle: {
        color: "#ffffff",
        fontSize: "2rem",
        fontWeight: 700,
        margin: 0,
    },
    cardWrap: {
        maxWidth: "80rem",
        margin: "-2.5rem auto 2.5rem",
    },
    card: {
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        backgroundColor: "#ffffff",
        marginTop: "-0.0625rem",
    },
    column: {
        padding: "2rem 2.5rem",
    },
    columnLeft: {
        padding: "2rem 2.5rem",
        borderRight: "0.0625rem solid #d1d5db",
    },
    columnHeading: {
        fontSize: "1.875rem",
        fontWeight: 700,
        margin: "0 0 0.75rem 0",
        color: "#292929",
    },
    columnLead: {
        fontSize: "1rem",
        margin: "0 0 1.5rem 0",
        color: "#292929",
    },
    primaryButton: {
        display: "inline-block",
        padding: "0.75rem 3rem",
        backgroundColor: "#267151",
        color: "#ffffff",
        border: "none",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "1rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        textDecoration: "none",
    },
    needTitle: {
        fontSize: "1rem",
        fontWeight: 700,
        margin: "1.75rem 0 1rem 0",
        color: "#404040",
    },
    needList: {
        listStyle: "none",
        padding: 0,
        margin: 0,
        display: "flex",
        flexDirection: "column" as const,
        gap: "1rem",
    },
    needItem: {
        display: "grid",
        gridTemplateColumns: "1.75rem 1fr",
        gap: "0.75rem",
        alignItems: "start",
    },
    needIcon: {
        color: "#267151",
        width: "1.5rem",
        height: "1.5rem",
        marginTop: "0.125rem",
    },
    needItemTitle: {
        fontWeight: 700,
        margin: "0 0 0.25rem 0",
        color: "#292929",
    },
    needItemBody: {
        margin: 0,
        color: "#292929",
        lineHeight: 1.5,
    },
    footerNote: {
        marginTop: "2rem",
        color: "#292929",
    },
    form: {
        display: "flex",
        flexDirection: "column" as const,
        gap: "1rem",
    },
    label: {
        fontSize: "1rem",
        fontWeight: 600,
        color: "#292929",
        marginBottom: "-0.5rem",
    },
    input: {
        padding: "0.75rem",
        border: "0.0625rem solid #6b7280",
        borderRadius: "0",
        fontSize: "1rem",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        color: "#292929",
        backgroundColor: "#ffffff",
        outline: "none",
        width: "100%",
    },
    passwordWrap: {
        position: "relative" as const,
    },
    showToggle: {
        position: "absolute" as const,
        right: "0.75rem",
        top: "50%",
        transform: "translateY(-50%)",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        color: "#267151",
        fontWeight: 800,
        textDecoration: "underline",
        padding: 0,
        fontSize: "1rem",
    },
    submit: {
        alignSelf: "flex-start",
        padding: "0.75rem 3rem",
        backgroundColor: "#267151",
        color: "#ffffff",
        border: "none",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "1rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    submitDisabled: {
        alignSelf: "flex-start",
        padding: "0.75rem 1.75rem",
        backgroundColor: "rgba(38, 113, 81, 0.5)",
        color: "#ffffff",
        border: "none",
        borderRadius: "0",
        cursor: "not-allowed",
        fontSize: "1rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    button: {
        padding: "0.75rem 3rem",
        backgroundColor: "#267151",
        color: "#ffffff",
        border: "none",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "1rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    buttonDisabled: {
        padding: "0.75rem 3rem",
        backgroundColor: "rgba(38, 113, 81, 0.5)",
        color: "#ffffff",
        border: "none",
        borderRadius: "0",
        cursor: "not-allowed",
        fontSize: "1rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    forgot: {
        marginTop: "0.5rem",
        color: "#267151",
        fontWeight: 800,
        textDecoration: "underline",
    },
    error: {
        padding: "0.75rem",
        color: "#b91c1c",
        backgroundColor: "#fecaca",
        fontSize: "0.875rem",
        fontWeight: 600,
        borderRadius: "0.25rem",
    },
    signedInPanel: {
        padding: "1.25rem",
        border: "0.0625rem solid #d1d5db",
        borderRadius: "0.25rem",
    },
    sendingMsg: {
        padding: "1.25rem",
        color: "#292929",
        fontSize: "1rem",
        fontWeight: 600,
        textAlign: "center" as const,
    },
} as const;

function MailIcon() {
    return (
        <svg style={styles.needIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="5" width="18" height="14" rx="1" />
            <path d="m3 7 9 6 9-6" />
        </svg>
    );
}

function PhoneIcon() {
    return (
        <svg style={styles.needIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="7" y="2" width="10" height="20" rx="2" />
            <path d="M11 18h2" />
        </svg>
    );
}

export default function Home() {
    const authClient = useAuthClient();

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [signInState, setSignInState] = useState<AuthFlowStateBase | null>(null);
    const [isSignedIn, setIsSignedIn] = useState(false);
    const [accountData, setAccountData] = useState<CustomAuthAccountData | undefined>(undefined);
    const [loadingAccountStatus, setLoadingAccountStatus] = useState(true);
    const [resendCountdown, setResendCountdown] = useState(0);

    // SMS / phone auth method registration states
    const [phoneAuthMethod, setPhoneAuthMethod] = useState<AuthenticationMethod | undefined>(undefined);
    const [mobileNumber, setMobileNumber] = useState("");
    const [dialCode, setDialCode] = useState("+61");
    const [smsCode, setSmsCode] = useState("");

    // MFA states
    const [selectedMfaAuthMethod, setSelectedMfaAuthMethod] = useState<AuthenticationMethod | undefined>(undefined);
    const [mfaChallenge, setMfaChallenge] = useState("");
    const [mfaAutoRequested, setMfaAutoRequested] = useState(false);

    const pickPhoneMethod = (methods: AuthenticationMethod[]): AuthenticationMethod | undefined => {
        const phone = methods.find((m) => {
            const ch = m.challenge_channel?.toLowerCase();
            return ch === "sms" || ch === "phone";
        });
        return phone ?? methods[0];
    };

    const handleCancel = () => {
        setSignInState(null);
        setPassword("");
        setCode("");
        setMobileNumber("");
        setSmsCode("");
        setPhoneAuthMethod(undefined);
        setSelectedMfaAuthMethod(undefined);
        setMfaChallenge("");
        setMfaAutoRequested(false);
        setError("");
    };

    // AADSTS552001 (continuation_token expired) wipes the server-side flow state, so
    // staying on the current step would leave the form stuck. Reset to the email step
    // (preserving the email so the user can resume quickly) and surface the message.
    const resetSignInToStart = (message: string) => {
        setSignInState(null);
        setPassword("");
        setCode("");
        setMobileNumber("");
        setSmsCode("");
        setPhoneAuthMethod(undefined);
        setSelectedMfaAuthMethod(undefined);
        setMfaChallenge("");
        setMfaAutoRequested(false);
        setError(message);
    };

    const handleAuthFailure = (err: unknown, fallback: string): boolean => {
        if (isContinuationTokenExpired(err)) {
            resetSignInToStart(friendlyAuthError(err, fallback));
            return true;
        }
        setError(friendlyAuthError(err, fallback));
        return false;
    };

    useEffect(() => {
        if (!authClient) return;
        const accountResult = authClient.getCurrentAccount();
        if (accountResult.isCompleted()) {
            setIsSignedIn(true);
            setAccountData(accountResult.data);
        }
        setLoadingAccountStatus(false);
    }, [authClient]);

    // Auto-advance: if MFA is required and we have a phone/SMS method, request the challenge
    // automatically so the user lands directly on the code entry screen.
    useEffect(() => {
        if (
            signInState instanceof MfaAwaitingState &&
            selectedMfaAuthMethod &&
            !mfaAutoRequested
        ) {
            setMfaAutoRequested(true);
            requestMfaChallenge(signInState, selectedMfaAuthMethod.id);
        }
        // requestMfaChallenge is recreated each render; the mfaAutoRequested guard prevents re-fire.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signInState, selectedMfaAuthMethod, mfaAutoRequested]);

    const handleRedirectFallback = async () => {
        if (!authClient) return;

        const popUpRequest: PopupRequest = {
            authority: customAuthConfig.auth.authority,
            scopes: [],
            redirectUri: customAuthConfig.auth.redirectUri || "",
            prompt: "login",
        };

        try {
            await authClient.loginPopup(popUpRequest);
            const accountResult = authClient.getCurrentAccount();

            if (accountResult.isFailed()) {
                handleAuthFailure(
                    accountResult.error,
                    "An error occurred while getting the account from cache"
                );
            }

            if (accountResult.isCompleted()) {
                setIsSignedIn(true);
                setAccountData(accountResult.data);
                setSignInState(new SignInCompletedState());
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "An unexpected error occurred while logging in with popup");
        }
    };

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (!authClient) return;

        setLoading(true);

        const startResult = await authClient.signIn({ username: email });

        if (startResult.isFailed()) {
            if (startResult.error?.isUserNotFound()) {
                setError("User not found");
            } else if (startResult.error?.isInvalidUsername()) {
                setError("Email address is invalid");
            } else if (startResult.error?.isPasswordIncorrect()) {
                setError("Password is invalid");
            } else if (startResult.error?.isRedirectRequired()) {
                await handleRedirectFallback();
            } else {
                handleAuthFailure(startResult.error, "An error occurred while signing in.");
            }
        }

        if (startResult.isCompleted()) {
            setIsSignedIn(true);
            setAccountData(startResult.data);
        }

        if (startResult.isAuthMethodRegistrationRequired()) {
            const methods = startResult.state.getAuthMethods();
            setPhoneAuthMethod(pickPhoneMethod(methods));
        }

        if (startResult.isMfaRequired()) {
            const methods = startResult.state.getAuthMethods();
            setSelectedMfaAuthMethod(pickPhoneMethod(methods));
            setMfaAutoRequested(false);
        }

        if (startResult.state instanceof SignInPasswordRequiredState && password) {
            // The home form already collected the password; submit it now.
            const passwordResult = await startResult.state.submitPassword(password);

            if (passwordResult.isFailed()) {
                if (passwordResult.error?.isInvalidPassword()) {
                    setError("Incorrect password");
                } else {
                    handleAuthFailure(
                        passwordResult.error,
                        "An error occurred while verifying the password"
                    );
                }
            }

            if (passwordResult.isCompleted()) {
                setIsSignedIn(true);
                setAccountData(passwordResult.data);
            }

            if (passwordResult.isAuthMethodRegistrationRequired()) {
                const methods = passwordResult.state.getAuthMethods();
                setPhoneAuthMethod(pickPhoneMethod(methods));
            }

            if (passwordResult.isMfaRequired()) {
                const methods = passwordResult.state.getAuthMethods();
                setSelectedMfaAuthMethod(pickPhoneMethod(methods));
                setMfaAutoRequested(false);
            }

            setSignInState(passwordResult.state);
        } else {
            setSignInState(startResult.state);
        }

        setLoading(false);
    };

    const handlePasswordSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);

        if (signInState instanceof SignInPasswordRequiredState) {
            const result = await signInState.submitPassword(password);

            if (result.isFailed()) {
                if (result.error?.isInvalidPassword()) {
                    setError("Incorrect password");
                } else {
                    handleAuthFailure(result.error, "An error occurred while verifying the password");
                }
            }

            if (result.isCompleted()) {
                setIsSignedIn(true);
                setAccountData(result.data);
                setSignInState(result.state);
            }

            if (result.isAuthMethodRegistrationRequired()) {
                const methods = result.state.getAuthMethods();
                setPhoneAuthMethod(pickPhoneMethod(methods));
                setSignInState(result.state);
            }

            if (result.isMfaRequired()) {
                const methods = result.state.getAuthMethods();
                setSelectedMfaAuthMethod(pickPhoneMethod(methods));
                setMfaAutoRequested(false);
                setSignInState(result.state);
            }
        }

        setLoading(false);
    };

    const handleCodeSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);

        if (signInState instanceof SignInCodeRequiredState) {
            const result = await signInState.submitCode(code);

            if (result.isFailed()) {
                if (result.error?.isInvalidCode()) {
                    setError("Invalid code");
                } else {
                    handleAuthFailure(result.error, "An error occurred while verifying the code");
                }
            }

            if (result.isCompleted()) {
                setIsSignedIn(true);
                setAccountData(result.data);
                setSignInState(result.state);
            }

            if (result.isAuthMethodRegistrationRequired()) {
                const methods = result.state.getAuthMethods();
                setPhoneAuthMethod(pickPhoneMethod(methods));
                setSignInState(result.state);
            }

            if (result.isMfaRequired()) {
                const methods = result.state.getAuthMethods();
                setSelectedMfaAuthMethod(pickPhoneMethod(methods));
                setMfaAutoRequested(false);
                setSignInState(result.state);
            }
        }

        setLoading(false);
    };

    const handleResendCode = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (signInState instanceof SignInCodeRequiredState) {
            const result = await signInState.resendCode();
            const state = result.state;

            if (result.isFailed()) {
                handleAuthFailure(result.error, "An error occurred while resending the code");
            } else {
                setSignInState(state);
                setResendCountdown(30);

                const timer = setInterval(() => {
                    setResendCountdown((prev) => {
                        if (prev <= 1) {
                            clearInterval(timer);
                            return 0;
                        }
                        return prev - 1;
                    });
                }, 1000);
            }
        }
    };

    const handleMobileSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (!(signInState instanceof AuthMethodRegistrationRequiredState)) return;
        if (!phoneAuthMethod) {
            setError("No phone authentication method is available for this account.");
            return;
        }

        const normalizedMobile = normalizeMobile(mobileNumber);
        if (normalizedMobile !== mobileNumber) {
            setMobileNumber(normalizedMobile);
        }

        setLoading(true);
        try {
            const localNumber = toLocalNumber(normalizedMobile);
            const result = await signInState.challengeAuthMethod({
                authMethodType: phoneAuthMethod,
                verificationContact: `${dialCode} ${localNumber}`,
            });

            if (result.isFailed()) {
                if (result.error?.isInvalidInput && result.error.isInvalidInput()) {
                    setError("The mobile number is invalid.");
                } else if (result.error?.isVerificationContactBlocked()) {
                    setError("This mobile number is blocked. Please use a different number.");
                } else {
                    handleAuthFailure(result.error, "An error occurred while sending the SMS code.");
                }
            }

            if (result.isCompleted()) {
                setIsSignedIn(true);
                setAccountData(result.data);
                setSignInState(result.state);
            }

            if (result.isVerificationRequired && result.isVerificationRequired()) {
                setSignInState(result.state);
            }
        } finally {
            setLoading(false);
        }
    };

    const handleResendSmsCode = async () => {
        if (!(signInState instanceof AuthMethodVerificationRequiredState)) return;
        if (!phoneAuthMethod) {
            setError("No phone authentication method is available for this account.");
            return;
        }

        setError("");
        setLoading(true);
        try {
            const localNumber = toLocalNumber(mobileNumber);
            const result = await signInState.challengeAuthMethod({
                authMethodType: phoneAuthMethod,
                verificationContact: `${dialCode} ${localNumber}`,
            });
            const state = result.state;

            if (result.isFailed()) {
                handleAuthFailure(result.error, "You hit the limit on the number of text messages. Try again shortly.");
                return;
            }

            setSignInState(state);
        } finally {
            setLoading(false);
        }
    };

    const handleSmsCodeSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (!(signInState instanceof AuthMethodVerificationRequiredState)) return;

        setLoading(true);
        try {
            const result = await signInState.submitChallenge(smsCode);

            if (result.isFailed()) {
                if (result.error?.isIncorrectChallenge && result.error.isIncorrectChallenge()) {
                    setError("Incorrect code.");
                } else {
                    handleAuthFailure(result.error, "An error occurred while verifying the SMS code.");
                }
            }

            if (result.isCompleted()) {
                setIsSignedIn(true);
                setAccountData(result.data);
                setSignInState(result.state);
            }
        } finally {
            setLoading(false);
        }
    };

    const requestMfaChallenge = async (state: MfaAwaitingState, methodId: string) => {
        const result = await state.requestChallenge(methodId);
        const next = result.state;

        if (result.isFailed()) {
            handleAuthFailure(result.error, "An error occurred while sending the verification code.");
            return;
        }

        setSignInState(next);
    };

    const handleResendMfaChallenge = async () => {
        if (!(signInState instanceof MfaVerificationRequiredState) || !selectedMfaAuthMethod) {
            return;
        }
        setError("");
        setLoading(true);
        try {
            const result = await signInState.requestChallenge(selectedMfaAuthMethod.id);
            const state = result.state;
            if (result.isFailed()) {
                handleAuthFailure(result.error, "You hit the limit on the number of text messages. Try again shortly.");
                return;
            }
            setSignInState(state);
        } finally {
            setLoading(false);
        }
    };

    const handleMfaChallengeSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);

        if (!mfaChallenge) {
            setError("Please enter a code.");
            setLoading(false);
            return;
        }

        if (signInState instanceof MfaVerificationRequiredState) {
            const result = await signInState.submitChallenge(mfaChallenge);

            if (result.isFailed()) {
                if (result.error?.isIncorrectChallenge()) {
                    setError("Incorrect code.");
                } else {
                    handleAuthFailure(result.error, "An error occurred while verifying the challenge response");
                }
            }

            if (result.isCompleted()) {
                setIsSignedIn(true);
                setAccountData(result.data);
                setSignInState(result.state);
            }
        }

        setLoading(false);
    };

    const renderRightColumn = () => {
        if (loadingAccountStatus) {
            return null;
        }

        if (signInState instanceof SignInPasswordRequiredState) {
            return (
                <PasswordForm
                    onSubmit={handlePasswordSubmit}
                    password={password}
                    setPassword={setPassword}
                    loading={loading}
                    submitButtonText="Log in"
                    submitButtonLoadingText="Logging in..."
                />
            );
        }

        if (signInState instanceof SignInCodeRequiredState) {
            return (
                <CodeForm
                    onSubmit={handleCodeSubmit}
                    code={code}
                    setCode={setCode}
                    loading={loading}
                    onResendCode={handleResendCode}
                    resendCountdown={resendCountdown}
                />
            );
        }

        if (signInState instanceof AuthMethodRegistrationRequiredState) {
            return (
                <MobileStep
                    onSubmit={handleMobileSubmit}
                    mobileNumber={mobileNumber}
                    setMobileNumber={setMobileNumber}
                    dialCode={dialCode}
                    setDialCode={setDialCode}
                    loading={loading}
                    onCancel={handleCancel}
                />
            );
        }

        if (signInState instanceof AuthMethodVerificationRequiredState) {
            return (
                <SmsCodeStep
                    onSubmit={handleSmsCodeSubmit}
                    code={smsCode}
                    setCode={setSmsCode}
                    loading={loading}
                    onCancel={handleCancel}
                    onResend={handleResendSmsCode}
                    mobileNumber={`${dialCode} ${mobileNumber}`}
                    serverError={error}
                />
            );
        }

        if (signInState instanceof MfaAwaitingState) {
            return <div style={styles.sendingMsg}>Sending verification code…</div>;
        }

        if (signInState instanceof MfaVerificationRequiredState) {
            return (
                <SmsCodeStep
                    onSubmit={handleMfaChallengeSubmit}
                    code={mfaChallenge}
                    setCode={setMfaChallenge}
                    loading={loading}
                    onCancel={handleCancel}
                    onResend={handleResendMfaChallenge}
                    mobileNumber={signInState.getSentTo()}
                    serverError={error}
                    expectedCodeLength={signInState.getCodeLength()}
                />
            );
        }

        return (
            <form onSubmit={handleLogin} style={styles.form}>
                <label style={styles.label} htmlFor="email">
                    Email address
                </label>
                <input
                    id="email"
                    type="email"
                    placeholder="Enter your email address"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={styles.input}
                    required
                />

                <label style={styles.label} htmlFor="password">
                    Password
                </label>
                <div style={styles.passwordWrap}>
                    <input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        placeholder="Enter your password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        style={{ ...styles.input, paddingRight: "3.75rem" }}
                        required
                    />
                    <button type="button" style={styles.showToggle} onClick={() => setShowPassword((v) => !v)}>
                        {showPassword ? "Hide" : "Show"}
                    </button>
                </div>

                <button type="submit" style={loading ? styles.submitDisabled : styles.submit} disabled={loading}>
                    {loading ? "Logging in..." : "Log in"}
                </button>

                <Link href="/reset-password" style={styles.forgot}>
                    Forgot my password
                </Link>
            </form>
        );
    };

    if (isSignedIn) {
        return (
            <main style={styles.page}>
                <div style={styles.hero}>
                    <div style={styles.heroInner}>
                        <h1 style={styles.heroTitle}>Welcome to myServiceTas</h1>
                    </div>
                </div>
                <div style={styles.cardWrap}>
                    <div style={{ ...styles.card, gridTemplateColumns: "1fr" }}>
                        <div style={styles.column}>
                            <div style={styles.signedInPanel}>
                                {`The user '${accountData?.getAccount().username}' has signed in`}
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        );
    }

    const isSmsStep =
        signInState instanceof AuthMethodRegistrationRequiredState ||
        signInState instanceof AuthMethodVerificationRequiredState ||
        signInState instanceof MfaAwaitingState ||
        signInState instanceof MfaVerificationRequiredState;

    if (isSmsStep) {
        return (
            <div style={signUpStyles.pageWrapper}>
                <div style={signUpStyles.hero}>
                    <div style={signUpStyles.heroInner}>
                        <h1 style={signUpStyles.heroTitle}>Welcome to myServiceTas</h1>
                    </div>
                </div>
                <div style={signUpStyles.card}>
                    <div style={signUpStyles.cardInner}>
                        {renderRightColumn()}
                        {error &&
                            !(signInState instanceof AuthMethodVerificationRequiredState) &&
                            !(signInState instanceof MfaVerificationRequiredState) && (
                            <div style={signUpStyles.pageError} role="alert">
                                <span>{error}</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <main style={styles.page}>
            <div style={styles.hero}>
                <div style={styles.heroInner}>
                    <h1 style={styles.heroTitle}>Welcome to myServiceTas</h1>
                </div>
            </div>

            <div style={styles.cardWrap}>
                <div style={styles.card}>
                    <section style={styles.columnLeft}>
                        <h2 style={styles.columnHeading}>New here? Create an account</h2>
                        <p style={styles.columnLead}>Create an account if you are new to this portal.</p>

                        <Link href="/sign-up" style={styles.primaryButton}>
                            Create an account
                        </Link>

                        <p style={styles.needTitle}>You will need</p>
                        <ul style={styles.needList}>
                            <li style={styles.needItem}>
                                <MailIcon />
                                <div>
                                    <p style={styles.needItemTitle}>An individual email address</p>
                                    <p style={styles.needItemBody}>
                                        You cannot use a school email address or one you share with someone else. An
                                        email address can only be used for one account.
                                    </p>
                                </div>
                            </li>
                            <li style={styles.needItem}>
                                <PhoneIcon />
                                <div>
                                    <p style={styles.needItemTitle}>Mobile phone number</p>
                                    <p style={styles.needItemBody}>
                                        We use multi-factor authentication to help keep your account secure. You will
                                        need your mobile phone whenever you log in.
                                    </p>
                                </div>
                            </li>
                        </ul>

                        <p style={styles.footerNote}>
                            If you have questions or would like more information about myServiceTas, please visit the{" "}
                            <a href="https://www.service.tas.gov.au/" target="_blank" rel="noreferrer">
                                Service Tasmania website.
                            </a>
                        </p>
                    </section>

                    <section style={styles.column}>
                        <h2 style={styles.columnHeading}>Log in to myServiceTas</h2>
                        <p style={styles.columnLead}>If you have already created an account please log in</p>

                        {renderRightColumn()}

                        {error && <div style={styles.error}>{error}</div>}
                    </section>
                </div>
            </div>
        </main>
    );
}
