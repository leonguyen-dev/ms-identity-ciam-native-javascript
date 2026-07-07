"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import { useAuthClient } from "@/auth/AuthClientProvider";
import { loginRequest } from "@/config/auth-config";
import { styles } from "./styles/styles";
import { DetailsStep } from "./components/DetailsStep";
import { EmailStep } from "../shared/components/EmailStep";
import { VerificationCodeStep } from "../shared/components/VerificationCodeStep";
import {
    AuthFlowStateBase,
    SignUpAttributesRequiredState,
    SignUpCodeRequiredState,
    SignUpCompletedState,
    SignUpPasswordRequiredState,
    UserAccountAttributes,
    InvalidArgumentError,
} from "@azure/msal-browser/custom-auth";
import { WarningIcon, type FormError } from "../shared/components/FormErrors";
import { friendlyAuthError, isContinuationTokenExpired, isOtpSendExtensionBlock } from "../shared/utils/friendlyAuthError";
import { describePasswordError } from "../shared/utils/passwordValidation";
import { getEmailBlockReason, SERVER_BLOCKED_SIGNUP_MESSAGE } from "../shared/utils/emailBlocklist";
import { validateSignUpAttributesRemote } from "../shared/utils/validateSignUpAttributes";

/**
 * Native-auth sign-up inside the browser-delegated app (ported from the
 * native-auth sample). The account is created entirely in these React forms via
 * the custom-auth SDK; the differences from the native sample are at the END of
 * the flow:
 *
 *  - No auto sign-in / in-app SMS MFA registration. Native tokens would not give
 *    this app its normal browser session (native auth cannot mint the Entra web
 *    session cookie), so once the account exists the page hands off to a hosted
 *    `loginRedirect` seeded with `login_hint`. The hosted flow takes the
 *    password and walks the user through MFA phone registration (the "3/3"
 *    mobile step of the native sample) — so the step numbering here still runs
 *    1/3 → 2/3, with the hosted pages providing step 3.
 */
type UiStep = "email" | "emailCode" | "details" | "handoff";

// Maps server-side validation field keys (the /api/validate-attributes gate) to the
// DetailsStep input DOM ids, so each server error can render inline beneath its field.
const SERVER_FIELD_TO_INPUT_ID: Record<string, string> = {
    givenName: "signup-given-name",
    surname: "signup-family-name",
    dateOfBirth: "signup-dob",
    termsAccepted: "signup-terms",
};

export default function SignUpPage() {
    const router = useRouter();
    const authClient = useAuthClient();
    const { instance } = useMsal();
    const isAuthenticated = useIsAuthenticated();

    const [uiStep, setUiStep] = useState<UiStep>("email");

    const [email, setEmail] = useState("");
    const [emailCode, setEmailCode] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [givenName, setGivenName] = useState("");
    const [familyName, setFamilyName] = useState("");
    const [dateOfBirth, setDateOfBirth] = useState("");
    const [termsAccepted, setTermsAccepted] = useState(false);

    const [error, setError] = useState("");
    const [attributeErrors, setAttributeErrors] = useState<FormError[]>([]);
    const [loading, setLoading] = useState(false);
    const [signUpState, setSignUpState] = useState<AuthFlowStateBase | null>(null);

    const handleCancel = () => {
        router.push("/");
    };

    const handleResendCode = async () => {
        if (!(signUpState instanceof SignUpCodeRequiredState)) return;
        setError("");
        setLoading(true);
        try {
            const result = await signUpState.resendCode();
            const state = result.state;

            if (result.isFailed()) {
                handleAuthFailure(result.error, "Failed to resend the code.");
                return;
            }
            setSignUpState(state);
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
        setAttributeErrors([]);
        setError(message);
    };

    // Some flows (e.g. handleResendCode) don't currently rely on the SDK's
    // isTokenExpired() helper, so guard them with the AADSTS code check too.
    const handleAuthFailure = (err: unknown, fallback: string): boolean => {
        if (isContinuationTokenExpired(err)) {
            resetSignUpToStart(friendlyAuthError(err, "Your sign-up session expired. Please start again."));
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

        const blockReason = getEmailBlockReason(email);
        if (blockReason) {
            setError(blockReason);
            return;
        }

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
                } else if (isOtpSendExtensionBlock(result.error)) {
                    // The OnOtpSend extension returned a 403 — the server blocklist
                    // rejected an address the client list didn't catch.
                    setError(SERVER_BLOCKED_SIGNUP_MESSAGE);
                } else {
                    handleAuthFailure(result.error, "An error occurred while signing up.");
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
                    setError(friendlyAuthError(result.error, "Failed to verify the email code."));
                }
                return;
            }

            if (state instanceof SignUpCompletedState) {
                await handleSignInHandoff();
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
        setAttributeErrors([]);
        if (!authClient) return;
        setLoading(true);

        try {
            // Server-side validation gate (Option A). Native auth has no
            // OnAttributeCollectionSubmit hook, so we run the authoritative business-rule
            // check here before mutating any server-side flow state. The DetailsStep
            // component already did the same checks client-side for fast feedback.
            const validation = await validateSignUpAttributesRemote({
                givenName,
                surname: familyName,
                dateOfBirth,
                termsAccepted,
            });
            if (!validation.valid) {
                // The server validates every field and returns them all in `errors`,
                // keyed by attribute name. Attach each field's input id so the message
                // renders both in the summary and inline beneath its field. Errors with
                // no field key (e.g. the proxy-unreachable fallback) show in the summary.
                const fieldErrors = validation.errors ?? {};
                const keys = Object.keys(fieldErrors);
                setAttributeErrors(
                    keys.length > 0
                        ? keys.map((key) => ({ id: SERVER_FIELD_TO_INPUT_ID[key], message: fieldErrors[key] }))
                        : [{ message: validation.message ?? "One or more details are invalid." }]
                );
                return;
            }

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
                        setError(friendlyAuthError(pwResult.error, "Failed to submit password."));
                    }
                    return;
                }
                nextState = stateAfterPw;
            }

            if (nextState instanceof SignUpAttributesRequiredState) {
                const required = nextState.getRequiredAttributes();
                const dobAttr = required.find((a) => a.name.endsWith("dateOfBirth"));
                if (dobAttr) {
                    // <input type="date"> yields ISO YYYY-MM-DD; Entra's dateOfBirth
                    // attribute expects DD/MM/YYYY, so convert before submitting.
                    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
                    attributes[dobAttr.name] = iso
                        ? `${iso[3]}/${iso[2]}/${iso[1]}`
                        : dateOfBirth;
                }

                const termsAttr = required.find((a) => a.name.endsWith("termsAndConditions"));
                if (termsAttr) {
                    // Boolean attribute: send a real JSON boolean, not the string "true".
                    // UserAccountAttributes is typed Record<string, string>, so cast to assign.
                    (attributes as Record<string, unknown>)[termsAttr.name] = termsAccepted;
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
                        setError(friendlyAuthError(attrResult.error, "Failed to submit details."));
                    }
                    return;
                }
                nextState = stateAfterAttr;
            }

            if (nextState instanceof SignUpCompletedState) {
                await handleSignInHandoff();
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

    /**
     * The account now exists. Instead of the native sample's auto sign-in (whose
     * tokens would live outside this app's MSAL session and could never become a
     * web SSO session), hand off to the normal hosted sign-in seeded with the
     * new email. The hosted flow takes the password and registers the MFA phone
     * (step 3/3). loginRequest keeps prompt=login, which this app needs anyway
     * to sidestep stale-session loops.
     */
    const handleSignInHandoff = async () => {
        setUiStep("handoff");
        try {
            await instance.loginRedirect({ ...loginRequest, loginHint: email });
        } catch (err) {
            setError(
                friendlyAuthError(
                    err,
                    "Your account was created, but we couldn't start sign-in automatically. Please sign in from the homepage."
                )
            );
        }
    };

    const renderForm = () => {
        if (isAuthenticated && uiStep !== "handoff") {
            return <div style={styles.signed_in_msg}>Please sign out before processing the sign up.</div>;
        }

        if (uiStep === "handoff") {
            return (
                <div style={styles.signed_in_msg} role="status">
                    Your account has been created. Taking you to sign in&hellip;
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
                    fieldId="signup-email"
                    heading="Enter your email address (1/3)"
                    guideTitle="Email address guide"
                    guideItems={[
                        "Enter the email address you will use to sign in to your myServiceTas account.",
                        "We will email you a code which you will have to enter on the next screen.",
                        "You cannot use a school email address or one you share with someone else. An email address can only be used for one account.",
                    ]}
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
                    onResend={handleResendCode}
                    fieldId="signup-email-code"
                    heading="Enter the code (1/3)"
                    sentMessage={<>We sent an email to <strong>{email}</strong></>}
                    resendPrompt="Haven't got an email from us?"
                    serverError={error}
                    placeholder="Enter your code"
                    submitButtonText="Next"
                    submitButtonLoadingText="Working..."
                />
            );
        }

        return (
            <DetailsStep
                onSubmit={handleDetailsSubmit}
                serverErrors={attributeErrors}
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
                    {error && uiStep !== "email" && uiStep !== "emailCode" && (
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
