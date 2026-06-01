import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { EmailClient, type EmailMessage } from "@azure/communication-email";
import { buildOtpEmail } from "../emailTemplate";

/**
 * Entra External ID "OnOtpSend" (emailOtpSend) custom authentication extension.
 *
 * Entra POSTs the user's email + the one-time passcode it generated; this function
 * sends a branded email via Azure Communication Services, then tells Entra to
 * continue the flow. Entra validates the user's typed code against the same OTP,
 * so there is no second/duplicate code.
 *
 * One handler covers every Email-OTP flow: sign-up verification, sign-in OTP,
 * password reset, and email MFA — they all raise this same event.
 *
 * Auth: protect this endpoint with the Function App's built-in Authentication
 * (Easy Auth) wired to the "Azure Functions authentication events API" app
 * registration, per the Microsoft setup guide. The `function` authLevel key is a
 * second factor but is not a substitute for token validation in production.
 */

const connectionString = process.env.COMMUNICATION_SERVICES_CONNECTION_STRING;
const senderAddress = process.env.COMMUNICATION_SERVICES_SENDER_ADDRESS;
const brandName = process.env.MAIL_SENDER_DISPLAY_NAME || "myServiceTas";

// Shape of the slice of the Entra payload we consume. See:
// https://learn.microsoft.com/entra/identity-platform/custom-extension-email-otp-send-data
interface OnOtpSendPayload {
    data?: {
        otpContext?: {
            identifier?: string;
            oneTimeCode?: string;
        };
        authenticationContext?: {
            requestType?: string;
        };
    };
}

// Telling Entra to continue: it proceeds to validate the code the user enters.
const continueResponse: HttpResponseInit = {
    status: 200,
    jsonBody: {
        data: {
            "@odata.type": "microsoft.graph.OnOtpSendResponseData",
            actions: [{ "@odata.type": "microsoft.graph.OtpSend.continueWithDefaultBehavior" }],
        },
    },
};

export async function emailOtpSend(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    if (!connectionString || !senderAddress) {
        context.error("ACS settings missing: set COMMUNICATION_SERVICES_CONNECTION_STRING and COMMUNICATION_SERVICES_SENDER_ADDRESS.");
        return { status: 500, jsonBody: { error: "Email provider not configured." } };
    }

    let payload: OnOtpSendPayload;
    try {
        payload = (await request.json()) as OnOtpSendPayload;
    } catch {
        return { status: 400, jsonBody: { error: "Invalid JSON body." } };
    }

    const otp = payload.data?.otpContext;
    const email = otp?.identifier;
    const code = otp?.oneTimeCode;
    const requestType = payload.data?.authenticationContext?.requestType ?? "unknown";

    if (!email || !code) {
        return { status: 400, jsonBody: { error: "Missing otpContext.identifier or otpContext.oneTimeCode." } };
    }

    try {
        const client = new EmailClient(connectionString);
        const { subject, html, plainText } = buildOtpEmail({ email, code, brandName });
        const message: EmailMessage = {
            senderAddress,
            recipients: { to: [{ address: email }] },
            content: { subject, html, plainText },
        };

        // Submit the message to ACS and return immediately. Entra caps this
        // callout at 2s; awaiting pollUntilDone() would block on ACS delivery
        // status (routinely several seconds) and trip CustomExtensionTimedOut.
        // beginSend resolving means ACS has accepted the message and will
        // deliver it server-side, so we don't need to poll for completion.
        await client.beginSend(message);
        context.log(`OTP email queued (requestType=${requestType})`);

        return continueResponse;
    } catch (error) {
        context.error("Failed to send OTP email via ACS:", error);
        return { status: 500, jsonBody: { error: "Failed to send email." } };
    }
}

app.http("emailOtpSend", {
    methods: ["POST"],
    authLevel: "function",
    handler: emailOtpSend,
});
