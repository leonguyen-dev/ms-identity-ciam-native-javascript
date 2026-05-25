"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthClient } from "@/auth/AuthClientProvider";
import { styles } from "./styles/styles";
import { EmailStep } from "./components/EmailStep";
import { EmailCodeStep } from "./components/EmailCodeStep";
import { DetailsStep } from "./components/DetailsStep";
import { MobileStep } from "./components/MobileStep";
import { SmsCodeStep } from "./components/SmsCodeStep";
import {
    AuthFlowStateBase,
    CustomAuthAccountData,
    SignInCompletedState,
    SignUpAttributesRequiredState,
    SignUpCodeRequiredState,
    SignUpCompletedState,
    SignUpPasswordRequiredState,
    UserAccountAttributes,
    AuthMethodRegistrationRequiredState,
    AuthMethodVerificationRequiredState,
    AuthenticationMethod,
    MfaAwaitingState,
    MfaVerificationRequiredState,
    InvalidArgumentError,
} from "@azure/msal-browser/custom-auth";
import { MfaAuthMethodSelectionForm } from "../shared/components/MfaAuthMethodSelectionForm";
import { MfaChallengeForm } from "../shared/components/MfaChallengeForm";
import { WarningIcon } from "../shared/components/FormErrors";

type UiStep = "email" | "emailCode" | "details";

export default function SignUpPage() {
    const router = useRouter();
    const authClient = useAuthClient();

    const [uiStep, setUiStep] = useState<UiStep>("email");

    const [email, setEmail] = useState("");
    const [emailCode, setEmailCode] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [givenName, setGivenName] = useState("");
    const [familyName, setFamilyName] = useState("");
    const [dateOfBirth, setDateOfBirth] = useState("");
    const [termsAccepted, setTermsAccepted] = useState(false);
    const [mobileNumber, setMobileNumber] = useState("");
    const [dialCode, setDialCode] = useState("+61");
    const [smsCode, setSmsCode] = useState("");

    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [signUpState, setSignUpState] = useState<AuthFlowStateBase | null>(null);
    const [loadingAccountStatus, setLoadingAccountStatus] = useState(true);
    const [isSignedIn, setSignInState] = useState(false);
    const [data, setData] = useState<CustomAuthAccountData | undefined>(undefined);

    const [phoneAuthMethod, setPhoneAuthMethod] = useState<AuthenticationMethod | undefined>(undefined);

    // MFA states (kept for future SMS MFA sign-in flow)
    const [mfaAuthMethods, setMfaAuthMethods] = useState<AuthenticationMethod[]>([]);
    const [selectedMfaAuthMethod, setSelectedMfaAuthMethod] = useState<AuthenticationMethod | undefined>(undefined);
    const [mfaChallenge, setMfaChallenge] = useState("");

    useEffect(() => {
        const checkAccount = async () => {
            if (!authClient) return;

            const accountResult = authClient.getCurrentAccount();
            if (accountResult.isCompleted()) {
                setSignInState(true);
            }
            setLoadingAccountStatus(false);
        };

        checkAccount();
    }, [authClient]);

    const handleCancel = () => {
        router.push("/");
    };

    const handleResendCode = async () => {
        if (!authClient || !email) return;
        setError("");
        setLoading(true);
        try {
            const result = await authClient.signUp({ username: email });
            const state = result.state;
            if (result.isFailed()) {
                setError(result.error?.errorData.errorDescription || "Failed to resend the code.");
                return;
            }
            if (state instanceof SignUpCodeRequiredState) {
                setSignUpState(state);
            }
        } catch (err) {
            handleSubmitException(err, "Failed to resend the code.");
        } finally {
            setLoading(false);
        }
    };

    const resetSignUpToStart = (message: string) => {
        setSignUpState(null);
        setUiStep("email");
        setEmailCode("");
        setPassword("");
        setConfirmPassword("");
        setGivenName("");
        setFamilyName("");
        setDateOfBirth("");
        setTermsAccepted(false);
        setMobileNumber("");
        setDialCode("+61");
        setSmsCode("");
        setMfaAuthMethods([]);
        setSelectedMfaAuthMethod(undefined);
        setMfaChallenge("");
        setPhoneAuthMethod(undefined);
        setError(message);
    };

    const describePasswordError = (subError: string | undefined): string => {
        switch (subError) {
            case "password_too_weak":
                return "Your password is too weak. Use at least 3 of: lowercase, uppercase, numbers, symbols.";
            case "password_too_short":
                return "Your password is too short. It must be at least 8 characters.";
            case "password_too_long":
                return "Your password is too long. Please choose a shorter one.";
            case "password_recently_used":
                return "You can't reuse a recent password. Please choose a different one.";
            case "password_banned":
                return "That password is too common or contains a banned word. Please choose something less guessable.";
            case "password_is_invalid":
                return "Your password contains disallowed characters. Please choose a different one.";
            default:
                return "Invalid password.";
        }
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
            if (desc.includes("attributes")) {
                setError("Please fill in all required details.");
                return;
            }
            setError(fallback);
            return;
        }
        throw err;
    };

    const handleEmailSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        if (!authClient) return;
        setLoading(true);

        try {
            const result = await authClient.signUp({ username: email });
            const state = result.state;

            if (result.isFailed()) {
                if (result.error?.isUserAlreadyExists()) {
                    setError("This email address is already linked to another myServiceTas account");
                } else if (result.error?.isInvalidUsername()) {
                    setError("Please enter a valid email address.");
                } else {
                    setError(result.error?.errorData.errorDescription || "An error occurred while signing up.");
                }
                return;
            }

            if (state instanceof SignUpCodeRequiredState) {
                setSignUpState(state);
                setUiStep("emailCode");
                return;
            }

            if (
                state instanceof SignUpPasswordRequiredState ||
                state instanceof SignUpAttributesRequiredState
            ) {
                setSignUpState(state);
                setUiStep("details");
                return;
            }

            setError("Unexpected sign-up state — email verification was not requested.");
        } catch (err) {
            handleSubmitException(err, "An error occurred while signing up.");
        } finally {
            setLoading(false);
        }
    };

    const handleEmailCodeSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        if (!(signUpState instanceof SignUpCodeRequiredState)) {
            setError("Sign-up session was lost. Please start again.");
            return;
        }
        setLoading(true);

        try {
            const result = await signUpState.submitCode(emailCode);
            const state = result.state;

            if (result.isFailed()) {
                if (result.error?.isTokenExpired()) {
                    resetSignUpToStart("Your sign-up session expired. Please start again.");
                } else if (result.error?.isInvalidCode()) {
                    setError("That code is incorrect. Please try again.");
                } else {
                    setError(result.error?.errorData.errorDescription || "Failed to verify the email code.");
                }
                return;
            }

            if (state instanceof SignUpCompletedState) {
                await handleAutoSignIn(state);
                return;
            }

            setSignUpState(state);
            setUiStep("details");
        } catch (err) {
            handleSubmitException(err, "Failed to verify the email code.");
        } finally {
            setLoading(false);
        }
    };

    const handleDetailsSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        if (!authClient) return;
        setLoading(true);

        try {
            const attributes: UserAccountAttributes = {
                displayName: `${givenName} ${familyName}`.trim(),
                givenName,
                surname: familyName,
            } as UserAccountAttributes;

            let nextState: AuthFlowStateBase | null = signUpState;

            if (nextState instanceof SignUpPasswordRequiredState) {
                const pwResult = await nextState.submitPassword(password);
                const stateAfterPw = pwResult.state;

                if (pwResult.isFailed()) {
                    if (pwResult.error?.isTokenExpired()) {
                        resetSignUpToStart("Your sign-up session expired. Please start again.");
                    } else if (pwResult.error?.isInvalidPassword()) {
                        setError(describePasswordError(pwResult.error.errorData?.subError));
                    } else {
                        setError(pwResult.error?.errorData.errorDescription || "Failed to submit password.");
                    }
                    return;
                }
                nextState = stateAfterPw;
            }

            if (nextState instanceof SignUpAttributesRequiredState) {
                const required = nextState.getRequiredAttributes();
                const dobAttr = required.find((a) => a.name.endsWith("dateOfBirth"));
                if (dobAttr) {
                    attributes[dobAttr.name] = dateOfBirth;
                }
                const attrResult = await nextState.submitAttributes(attributes);
                const stateAfterAttr = attrResult.state;

                if (attrResult.isFailed()) {
                    if (attrResult.error?.isTokenExpired()) {
                        resetSignUpToStart("Your sign-up session expired. Please start again.");
                    } else if (attrResult.error?.isAttributesValidationFailed()) {
                        setError("One or more details are invalid.");
                    } else if (attrResult.error?.isMissingRequiredAttributes()) {
                        setError("Missing required details.");
                    } else {
                        setError(attrResult.error?.errorData.errorDescription || "Failed to submit details.");
                    }
                    return;
                }
                nextState = stateAfterAttr;
            }

            if (nextState instanceof SignUpCompletedState) {
                await handleAutoSignIn(nextState);
                return;
            }

            if (nextState) {
                setSignUpState(nextState);
            }
        } catch (err) {
            handleSubmitException(err, "Failed to submit details.");
        } finally {
            setLoading(false);
        }
    };

    const handleAutoSignIn = async (completedState: SignUpCompletedState) => {
        const result = await completedState.signIn();

        if (result.isFailed()) {
            setError(result.error?.errorData?.errorDescription || "An error occurred during auto sign-in.");
        }

        if (result.isAuthMethodRegistrationRequired()) {
            const methods = result.state.getAuthMethods();
            const phone = pickPhoneMethod(methods);
            setPhoneAuthMethod(phone);
            setSignUpState(result.state);
            return;
        }

        if (result.isMfaRequired()) {
            const methods = result.state.getAuthMethods();
            setMfaAuthMethods(methods);
            setSelectedMfaAuthMethod(methods.length > 0 ? methods[0] : undefined);
            setSignUpState(result.state);
            return;
        }

        if (result.isCompleted()) {
            setData(result.data);
            setSignUpState(result.state);
            setSignInState(true);
        }
    };

    const pickPhoneMethod = (methods: AuthenticationMethod[]): AuthenticationMethod | undefined => {
        const phone = methods.find((m) => {
            const ch = m.challenge_channel?.toLowerCase();
            return ch === "sms" || ch === "phone";
        });
        return phone ?? methods[0];
    };

    const handleMobileSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (!(signUpState instanceof AuthMethodRegistrationRequiredState)) return;
        if (!phoneAuthMethod) {
            setError("No phone authentication method is available for this account.");
            return;
        }

        setLoading(true);
        try {
            const localNumber = mobileNumber.replace(/\D/g, "").replace(/^0+/, "");
            const result = await signUpState.challengeAuthMethod({
                authMethodType: phoneAuthMethod,
                verificationContact: `${dialCode} ${localNumber}`,
            });

            if (result.isFailed()) {
                if (result.error?.isTokenExpired()) {
                    resetSignUpToStart("Your sign-up session expired. Please start again.");
                    return;
                } else if (result.error?.isInvalidInput && result.error.isInvalidInput()) {
                    setError("The mobile number is invalid.");
                } else if (result.error?.isVerificationContactBlocked()) {
                    setError("This mobile number is blocked. Please use a different number.");
                } else {
                    setError(
                        result.error?.errorData?.errorDescription || "An error occurred while sending the SMS code."
                    );
                }
            }

            if (result.isCompleted()) {
                setData(result.data);
                setSignUpState(result.state);
                setSignInState(true);
            }

            if (result.isVerificationRequired && result.isVerificationRequired()) {
                setSignUpState(result.state);
            }
        } catch (err) {
            handleSubmitException(err, "An error occurred while sending the SMS code.");
        } finally {
            setLoading(false);
        }
    };

    const handleResendSmsCode = async () => {
        if (!(signUpState instanceof AuthMethodVerificationRequiredState)) return;
        if (!phoneAuthMethod) {
            setError("No phone authentication method is available for this account.");
            return;
        }
        setError("");
        setLoading(true);
        try {
            const localNumber = mobileNumber.replace(/\D/g, "").replace(/^0+/, "");
            const result = await signUpState.challengeAuthMethod({
                authMethodType: phoneAuthMethod,
                verificationContact: `${dialCode} ${localNumber}`,
            });

            if (result.isFailed()) {
                if (result.error?.isTokenExpired()) {
                    resetSignUpToStart("Your sign-up session expired. Please start again.");
                    return;
                }
                setError(result.error?.errorData?.errorDescription || "Failed to resend the SMS code.");
                return;
            }

            if (result.isVerificationRequired()) {
                setSignUpState(result.state);
            }
        } catch (err) {
            handleSubmitException(err, "Failed to resend the SMS code.");
        } finally {
            setLoading(false);
        }
    };

    const handleSmsCodeSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (!(signUpState instanceof AuthMethodVerificationRequiredState)) return;

        setLoading(true);
        try {
            const result = await signUpState.submitChallenge(smsCode);

            if (result.isFailed()) {
                if (result.error?.isTokenExpired()) {
                    resetSignUpToStart("Your sign-up session expired. Please start again.");
                    return;
                } else if (result.error?.isIncorrectChallenge && result.error.isIncorrectChallenge()) {
                    setError("Incorrect code.");
                } else {
                    setError(
                        result.error?.errorData?.errorDescription || "An error occurred while verifying the SMS code."
                    );
                }
            }

            if (result.isCompleted()) {
                setData(result.data);
                setSignUpState(result.state);
                setSignInState(true);
            }
        } catch (err) {
            handleSubmitException(err, "An error occurred while verifying the SMS code.");
        } finally {
            setLoading(false);
        }
    };

    const handleMfaAuthMethodSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);

        if (!selectedMfaAuthMethod) {
            setError("Please select an authentication method.");
            setLoading(false);
            return;
        }

        if (signUpState instanceof MfaAwaitingState) {
            try {
                const result = await signUpState.requestChallenge(selectedMfaAuthMethod.id);

                if (result.isFailed()) {
                    if (result.error?.isTokenExpired()) {
                        resetSignUpToStart("Your sign-up session expired. Please start again.");
                    } else if (result.error?.isInvalidInput()) {
                        setError("Incorrect verification contact.");
                    } else {
                        setError(
                            result.error?.errorData?.errorDescription ||
                                "An error occurred while verifying the authentication method"
                        );
                    }
                }

                if (result.isVerificationRequired()) {
                    setSignUpState(result.state);
                }
            } catch (err) {
                handleSubmitException(err, "An error occurred while verifying the authentication method");
            }
        }

        setLoading(false);
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

        if (signUpState instanceof MfaVerificationRequiredState) {
            try {
                const result = await signUpState.submitChallenge(mfaChallenge);

                if (result.isFailed()) {
                    if (result.error?.isTokenExpired()) {
                        resetSignUpToStart("Your sign-up session expired. Please start again.");
                    } else if (result.error?.isIncorrectChallenge()) {
                        setError("Incorrect code.");
                    } else {
                        setError(
                            result.error?.errorData?.errorDescription ||
                                "An error occurred while verifying the challenge response"
                        );
                    }
                }

                if (result.isCompleted()) {
                    setData(result.data);
                    setSignInState(true);
                    setSignUpState(result.state);
                }
            } catch (err) {
                handleSubmitException(err, "An error occurred while verifying the challenge response");
            }
        }

        setLoading(false);
    };

    const renderForm = () => {
        if (loadingAccountStatus) return null;

        if (isSignedIn) {
            return <div style={styles.signed_in_msg}>Please sign out before processing the sign up.</div>;
        }

        if (signUpState instanceof AuthMethodRegistrationRequiredState) {
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

        if (signUpState instanceof AuthMethodVerificationRequiredState) {
            return (
                <SmsCodeStep
                    onSubmit={handleSmsCodeSubmit}
                    code={smsCode}
                    setCode={setSmsCode}
                    loading={loading}
                    onCancel={handleCancel}
                    onResend={handleResendSmsCode}
                    mobileNumber={mobileNumber}
                    serverError={error}
                />
            );
        }

        if (signUpState instanceof MfaAwaitingState) {
            return (
                <MfaAuthMethodSelectionForm
                    onSubmit={handleMfaAuthMethodSubmit}
                    authMethods={mfaAuthMethods}
                    selectedAuthMethod={selectedMfaAuthMethod}
                    setSelectedAuthMethod={setSelectedMfaAuthMethod}
                    loading={loading}
                    styles={styles}
                />
            );
        }

        if (signUpState instanceof MfaVerificationRequiredState) {
            return (
                <MfaChallengeForm
                    onSubmit={handleMfaChallengeSubmit}
                    challenge={mfaChallenge}
                    setChallenge={setMfaChallenge}
                    loading={loading}
                    styles={styles}
                />
            );
        }

        if (signUpState instanceof SignInCompletedState) {
            return (
                <div style={styles.signed_in_msg}>
                    Sign up completed! Automatically signed in as {data?.getAccount().username}
                </div>
            );
        }

        if (uiStep === "email") {
            return (
                <EmailStep
                    onSubmit={handleEmailSubmit}
                    email={email}
                    setEmail={setEmail}
                    loading={loading}
                    onCancel={handleCancel}
                    serverError={error}
                />
            );
        }

        if (uiStep === "emailCode") {
            return (
                <EmailCodeStep
                    onSubmit={handleEmailCodeSubmit}
                    code={emailCode}
                    setCode={setEmailCode}
                    loading={loading}
                    email={email}
                    onCancel={handleCancel}
                    onResend={handleResendCode}
                    serverError={error}
                />
            );
        }

        return (
            <DetailsStep
                onSubmit={handleDetailsSubmit}
                password={password}
                setPassword={setPassword}
                confirmPassword={confirmPassword}
                setConfirmPassword={setConfirmPassword}
                givenName={givenName}
                setGivenName={setGivenName}
                familyName={familyName}
                setFamilyName={setFamilyName}
                dateOfBirth={dateOfBirth}
                setDateOfBirth={setDateOfBirth}
                termsAccepted={termsAccepted}
                setTermsAccepted={setTermsAccepted}
                loading={loading}
                onCancel={handleCancel}
            />
        );
    };

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
                    {error &&
                        uiStep !== "email" &&
                        uiStep !== "emailCode" &&
                        !(signUpState instanceof AuthMethodVerificationRequiredState) && (
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
