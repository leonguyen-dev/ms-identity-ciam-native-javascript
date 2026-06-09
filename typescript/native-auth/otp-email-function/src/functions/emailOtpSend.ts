import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { EmailClient, type EmailMessage } from "@azure/communication-email";
import { buildOtpEmail } from "../emailTemplate";
import { getEmailBlockReason } from "../emailBlocklist";

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
 * Email blocklist: this is the native-auth enforcement point for the email
 * blocklist. Native auth never fires OnAttributeCollectionStart, but it does fire
 * OnOtpSend, and this is the earliest server hook — it runs before any code is
 * sent. When the email is blocked we DON'T send the email and return a non-success
 * response, which fails the OTP callout. OnOtpSend has no `showBlockPage` action,
 * so the failure surfaces to the client as a generic error; the friendly message
 * is shown by the React client's own pre-signUp() check.
 *
 * Browser-delegated sign-up is the exception: a generic error in the Entra-hosted
 * UI is poor UX, and unlike native auth that flow DOES fire OnAttributeCollectionStart
 * (which can `showBlockPage`). So when requestType === "signUp" (the browser user
 * flow) we deliberately let the OTP send and defer the block to that event, which
 * renders a branded message. Every other flow — native (different/empty requestType)
 * and browser sign-in / reset / MFA — is blocked here. requestType is logged on
 * every call for visibility.
 *
 * Auth: protect this endpoint with the Function App's built-in Authentication
 * (Easy Auth) wired to the "Azure Functions authentication events API" app
 * registration, per the Microsoft setup guide. The `function` authLevel key is a
 * second factor but is not a substitute for token validation in production.
 */

const connectionString = process.env.COMMUNICATION_SERVICES_CONNECTION_STRING;
const senderAddress = process.env.COMMUNICATION_SERVICES_SENDER_ADDRESS;
const brandName = process.env.MAIL_SENDER_DISPLAY_NAME || "myServiceTas";

// Build the ACS client once at module load and reuse it across warm
// invocations. Constructing it per-call rebuilds the HTTP pipeline + auth
// policy every time, adding avoidable latency under Entra's ~2s callout budget.
// Undefined if the connection string is missing; the handler guards on that.
const emailClient = connectionString ? new EmailClient(connectionString) : undefined;

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
    if (!emailClient || !senderAddress) {
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

    // Diagnostic: native auth's actual requestType value for OTP isn't documented
    // (the docs/sample show "signUp" for the browser user-flow only). Log it on
    // every call so the real value is visible in the Function App's Log stream.
    context.log(`OnOtpSend: requestType='${requestType}', identifier='${email}'.`);

    // Email blocklist enforcement.
    //
    // OnOtpSend has no `showBlockPage` action, so a 403 here always renders Entra's
    // GENERIC error in the hosted UI. To give browser-delegated sign-up a friendly,
    // branded message, we DON'T block it here — we let the OTP send and block it one
    // step later in OnAttributeCollectionStart, which can `showBlockPage`. That event
    // only fires for the browser user flow's sign-up (requestType === "signUp"), so
    // we hand that case off and block everything else here:
    //   - native auth (sign-up/sign-in/reset/MFA): never fires attribute events, and
    //     sends a different/empty requestType, so it's blocked here; the React client
    //     shows its own friendly message via its pre-signUp() check.
    //   - browser sign-in / reset / MFA: no attribute-collection step to defer to, so
    //     a banned address is blocked here (generic error is acceptable — the account
    //     shouldn't exist anyway).
    // A blocked email gets no OTP; the non-success response fails the callout.
    const blockReason = getEmailBlockReason(email);
    const deferToAttributeStart = requestType.toLowerCase() === "signup";
    if (blockReason && !deferToAttributeStart) {
        context.log(`OnOtpSend: blocking '${email}' (requestType='${requestType}') — not sending OTP.`);
        return { status: 403, jsonBody: { error: blockReason } };
    }
    if (blockReason) {
        context.log(`OnOtpSend: '${email}' is blocklisted but requestType='${requestType}' (browser sign-up) — sending OTP; OnAttributeCollectionStart will block with a branded page.`);
    }

    try {
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
        await emailClient.beginSend(message);
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
