"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthClient } from "@/auth/AuthClientProvider";
import { styles } from "./styles/styles";
import { VerifyIdentityStep } from "./components/VerifyIdentityStep";
import { NewPasswordForm } from "./components/NewPasswordForm";
import { EmailStep } from "../shared/components/EmailStep";
import { VerificationCodeStep } from "../shared/components/VerificationCodeStep";
import {
    ResetPasswordCodeRequiredState,
    ResetPasswordPasswordRequiredState,
    ResetPasswordCompletedState,
    AuthFlowStateBase,
    CustomAuthAccountData,
    SignInCompletedState,
    MfaAwaitingState,
    MfaVerificationRequiredState,
    InvalidArgumentError,
} from "@azure/msal-browser/custom-auth";
import { WarningIcon } from "../shared/components/FormErrors";
import { friendlyAuthError, isContinuationTokenExpired } from "../shared/utils/friendlyAuthError";
import { pickPhoneMethod } from "../shared/utils/authMethods";
import { describePasswordError } from "../shared/utils/passwordValidation";

type UiStep = "email" | "emailCode" | "verifyIdentity" | "smsCode" | "newPassword";

export default function ResetPassword() {
    const app = useAuthClient();
    const router = useRouter();

    const [loadingAccountStatus, setLoadingAccountStatus] = useState(true);
    const [isSignedIn, setSignInState] = useState(false);

    const [uiStep, setUiStep] = useState<UiStep>("email");
    const [username, setUsername] = useState("");
    const [emailCode, setEmailCode] = useState("");
    const [smsCode, setSmsCode] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");

    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [resetState, setResetState] = useState<AuthFlowStateBase | null>(null);
    const [maskedMobile, setMaskedMobile] = useState<string | undefined>(undefined);
    const [data, setData] = useState<CustomAuthAccountData | undefined>(undefined);

    useEffect(() => {
        const checkAccount = async () => {
            if (!app) return;

            const accountResult = app.getCurrentAccount();

            if (accountResult.isCompleted()) {
                setSignInState(true);
            }

            setLoadingAccountStatus(false);
        };

        checkAccount();
    }, [app]);

    const handleCancel = () => {
        router.push("/");
    };

    const resetResetPasswordToStart = (message: string) => {
        setResetState(null);
        setUiStep("email");
        setEmailCode("");
        setSmsCode("");
        setNewPassword("");
        setConfirmPassword("");
        setMaskedMobile(undefined);
        setError(message);
    };

    const handleAuthFailure = (err: unknown, fallback: string): boolean => {
        if (isContinuationTokenExpired(err)) {
            resetResetPasswordToStart(friendlyAuthError(err, fallback));
            return true;
        }
        setError(friendlyAuthError(err, fallback));
        return false;
    };

    const handleSubmitException = (err: unknown, fallback: string): void => {
        if (err instanceof InvalidArgumentError) {
            const desc = err.errorDescription ?? "";
            if (desc.includes("code") || desc.includes("challenge")) {
                setError("Please enter the full verification code.");
                return;
            }
            if (desc.includes("password")) {
                setError("Please enter your password.");
                return;
            }
            setError(fallback);
            return;
        }
        throw err;
    };

    const handleEmailSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!app) return;

        setError("");
        setLoading(true);

        try {
            const result = await app.resetPassword({ username });
            const state = result.state;

            if (result.isFailed()) {
                if (result.error?.isInvalidUsername()) {
                    setError("Please enter a valid email address.");
                } else if (result.error?.isUserNotFound()) {
                    setError("We could not find an account with that email address.");
                } else {
                    handleAuthFailure(result.error, "An error occurred while initiating password reset.");
                }
                return;
            }

            if (state instanceof ResetPasswordCodeRequiredState) {
                setResetState(state);
                setUiStep("emailCode");
            }
        } catch (err) {
            handleSubmitException(err, "An error occurred while initiating password reset.");
        } finally {
            setLoading(false);
        }
    };

    const handleResendEmailCode = async () => {
        if (!(resetState instanceof ResetPasswordCodeRequiredState)) return;

        setError("");
        setLoading(true);

        try {
            const result = await resetState.resendCode();
            const state = result.state;
            if (result.isFailed()) {
                handleAuthFailure(result.error, "An error occurred while resending the code.");
                return;
            }
            setResetState(state);
        } catch (err) {
            handleSubmitException(err, "An error occurred while resending the code.");
        } finally {
            setLoading(false);
        }
    };

    const handleEmailCodeSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!(resetState instanceof ResetPasswordCodeRequiredState)) {
            resetResetPasswordToStart("Your reset session was lost. Please start again.");
            return;
        }

        setError("");
        setLoading(true);

        try {
            const result = await resetState.submitCode(emailCode);
            const state = result.state;

            if (result.isFailed()) {
                if (result.error?.isInvalidCode()) {
                    setError("That code is incorrect. Please try again.");
                } else {
                    handleAuthFailure(result.error, "An error occurred while verifying the code.");
                }
                return;
            }

            if (state instanceof ResetPasswordPasswordRequiredState) {
                setResetState(state);
                setUiStep("verifyIdentity");
            }
        } catch (err) {
            handleSubmitException(err, "An error occurred while verifying the code.");
        } finally {
            setLoading(false);
        }
    };

    const handleVerifyIdentitySubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setUiStep("smsCode");
    };

    const handleResendSmsCode = () => {
        setError("");
        setSmsCode("");
    };

    const handleSmsCodeSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setUiStep("newPassword");
    };

    const handleNewPasswordSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (!(resetState instanceof ResetPasswordPasswordRequiredState)) {
            resetResetPasswordToStart("Your reset session was lost. Please start again.");
            return;
        }

        setLoading(true);

        try {
            const pwResult = await resetState.submitNewPassword(newPassword);
            const pwState = pwResult.state;

            if (pwResult.isFailed()) {
                if (pwResult.error?.isInvalidPassword()) {
                    setError(describePasswordError(pwResult.error.errorData?.subError));
                } else {
                    handleAuthFailure(pwResult.error, "An error occurred while setting your new password.");
                }
                return;
            }

            if (!(pwState instanceof ResetPasswordCompletedState)) {
                setError("Unexpected state after submitting the new password.");
                return;
            }

            await completeWithMfa(pwState);
        } catch (err) {
            handleSubmitException(err, "An error occurred while setting your new password.");
        } finally {
            setLoading(false);
        }
    };

    const completeWithMfa = async (completedState: ResetPasswordCompletedState) => {
        const signInResult = await completedState.signIn();
        const signInState = signInResult.state;
        const signInData = signInResult.data;

        if (signInResult.isFailed()) {
            handleAuthFailure(signInResult.error, "An error occurred during sign-in.");
            return;
        }

        if (signInState instanceof SignInCompletedState) {
            setData(signInData);
            setResetState(signInState);
            setSignInState(true);
            return;
        }

        if (!(signInState instanceof MfaAwaitingState)) {
            setError("Unexpected state after sign-in.");
            return;
        }

        const methods = signInState.getAuthMethods();
        const phone = pickPhoneMethod(methods);

        if (!phone) {
            setError("No verification method is available for this account.");
            setResetState(signInState);
            return;
        }

        const challengeResult = await signInState.requestChallenge(phone.id);
        const challengeState = challengeResult.state;

        if (challengeResult.isFailed()) {
            handleAuthFailure(challengeResult.error, "An error occurred while sending the verification code.");
            return;
        }

        if (!(challengeState instanceof MfaVerificationRequiredState)) {
            setError("Unexpected MFA state after requesting the challenge.");
            return;
        }

        const sentTo = challengeState.getSentTo();
        if (sentTo) {
            setMaskedMobile(sentTo);
        }

        const submitResult = await challengeState.submitChallenge(smsCode);
        const submitState = submitResult.state;
        const submitData = submitResult.data;

        if (submitResult.isFailed()) {
            if (submitResult.error?.isIncorrectChallenge()) {
                setError("That SMS code is incorrect. Please go back and re-enter the code.");
                setResetState(challengeState);
                setUiStep("smsCode");
            } else {
                handleAuthFailure(submitResult.error, "An error occurred while verifying the SMS code.");
            }
            return;
        }

        setData(submitData);
        setResetState(submitState);
        setSignInState(true);
    };

    const renderForm = () => {
        if (loadingAccountStatus) return null;

        if (isSignedIn) {
            return <div style={styles.signed_in_msg}>Please sign out before processing the password reset.</div>;
        }

        if (resetState instanceof SignInCompletedState) {
            return (
                <div style={styles.signed_in_msg}>
                    Password reset completed! Automatically signed in as {data?.getAccount().username}.
                </div>
            );
        }

        if (uiStep === "email") {
            return (
                <EmailStep
                    onSubmit={handleEmailSubmit}
                    email={username}
                    setEmail={setUsername}
                    loading={loading}
                    onCancel={handleCancel}
                    serverError={error}
                    fieldId="reset-email"
                    heading="Enter your email address (1/5)"
                />
            );
        }

        if (uiStep === "emailCode") {
            return (
                <VerificationCodeStep
                    onSubmit={handleEmailCodeSubmit}
                    code={emailCode}
                    setCode={setEmailCode}
                    loading={loading}
                    onCancel={handleCancel}
                    onResend={handleResendEmailCode}
                    fieldId="reset-email-code"
                    heading="Enter the code (2/5)"
                    sentMessage={<>Please check your email address for a verification code.</>}
                    resendPrompt="Haven't got an email from us?"
                    serverError={error}
                    placeholder="Enter your code"
                    submitButtonText="Next"
                    submitButtonLoadingText="Working..."
                />
            );
        }

        if (uiStep === "verifyIdentity") {
            return (
                <VerifyIdentityStep
                    onSubmit={handleVerifyIdentitySubmit}
                    onCancel={handleCancel}
                    loading={loading}
                    maskedMobile={maskedMobile}
                />
            );
        }

        if (uiStep === "smsCode") {
            return (
                <VerificationCodeStep
                    onSubmit={handleSmsCodeSubmit}
                    code={smsCode}
                    setCode={setSmsCode}
                    loading={loading}
                    onCancel={handleCancel}
                    onResend={handleResendSmsCode}
                    fieldId="reset-sms-code"
                    heading="Enter the code (4/5)"
                    sentMessage={
                        maskedMobile ? (
                            <>We sent a code to <strong>{maskedMobile}</strong></>
                        ) : (
                            <>We sent a code to your mobile number.</>
                        )
                    }
                    resendPrompt="Haven't got an SMS from us?"
                    serverError={error}
                    defaultCodeLength={6}
                    placeholder="Enter your code"
                    submitButtonText="Verify code"
                    submitButtonLoadingText="Verifying..."
                    emptyCodeMessage="Please enter the verification code you received."
                />
            );
        }

        return (
            <NewPasswordForm
                onSubmit={handleNewPasswordSubmit}
                password={newPassword}
                setPassword={setNewPassword}
                confirmPassword={confirmPassword}
                setConfirmPassword={setConfirmPassword}
                loading={loading}
                onCancel={handleCancel}
                serverError={error}
            />
        );
    };

    const showPageError =
        error &&
        uiStep !== "email" &&
        uiStep !== "emailCode" &&
        uiStep !== "smsCode" &&
        uiStep !== "newPassword";

    return (
        <div style={styles.pageWrapper}>
            <div style={styles.hero}>
                <div style={styles.heroInner}>
                    <h1 style={styles.heroTitle}>Welcome to myServiceTas</h1>
                </div>
            </div>
            <div style={styles.card}>
                <div style={styles.cardInner}>
                    {renderForm()}
                    {showPageError && (
                        <div style={styles.pageError} role="alert">
                            <WarningIcon />
                            <span>{error}</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
