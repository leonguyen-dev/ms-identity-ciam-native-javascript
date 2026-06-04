import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getEmailBlockReason } from "../emailBlocklist";

/**
 * Entra External ID "OnAttributeCollectionStart" custom authentication extension.
 *
 * Fires at the START of the attribute-collection step — after the user's email is
 * verified by OTP, but before the details page is collected. Entra POSTs the
 * user's verified email identity; this function blocks sign-up when the email is
 * on the blocklist (`showBlockPage`) and otherwise lets the flow continue
 * (`continueWithDefaultBehavior`).
 *
 * This is the server-side, non-bypassable counterpart to the client-side blocklist
 * in the React app (react-nextjs-sample/src/app/shared/utils/emailBlocklist.ts).
 * The client check is UX only (it stops a blocked email before any OTP is sent);
 * this one is the actual enforcement. Keep both lists in sync.
 *
 * Note: this event can't run BEFORE the email OTP — Entra has no pre-OTP
 * extension point — so a blocked email reaching this function has already verified
 * its address. The client-side check is what spares blocked users the OTP step.
 *
 * Auth: protect this endpoint with the Function App's built-in Authentication
 * (Easy Auth) wired to the "Azure Functions authentication events API" app
 * registration, per the Microsoft setup guide. The `function` authLevel key is a
 * second factor but is not a substitute for token validation in production.
 *
 * Schema: https://learn.microsoft.com/entra/identity-platform/custom-extension-onattributecollectionstart-retrieve-return-data
 */

const RESPONSE_DATA_TYPE = "microsoft.graph.onAttributeCollectionStartResponseData";

// Shape of the slice of the Entra payload we consume.
interface Identity {
    signInType?: string;
    issuer?: string;
    issuerAssignedId?: string;
}

interface OnAttributeCollectionStartPayload {
    data?: {
        userSignUpInfo?: {
            identities?: Identity[];
        };
    };
}

// Tell Entra to render the attribute-collection page as usual.
const continueResponse: HttpResponseInit = {
    status: 200,
    jsonBody: {
        data: {
            "@odata.type": RESPONSE_DATA_TYPE,
            actions: [{ "@odata.type": "microsoft.graph.attributeCollectionStart.continueWithDefaultBehavior" }],
        },
    },
};

// Stop the sign-up with a blocking message.
function blockPageResponse(title: string, message: string): HttpResponseInit {
    return {
        status: 200,
        jsonBody: {
            data: {
                "@odata.type": RESPONSE_DATA_TYPE,
                actions: [
                    {
                        "@odata.type": "microsoft.graph.attributeCollectionStart.showBlockPage",
                        title,
                        message,
                    },
                ],
            },
        },
    };
}

export async function attributeCollectionStart(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    let payload: OnAttributeCollectionStartPayload;
    try {
        payload = (await request.json()) as OnAttributeCollectionStartPayload;
    } catch {
        return { status: 400, jsonBody: { error: "Invalid JSON body." } };
    }

    // The verified email arrives as an "email" identity, not as an attribute.
    const email = payload.data?.userSignUpInfo?.identities?.find(
        (id) => id.signInType === "email"
    )?.issuerAssignedId;

    if (!email) {
        // No email to evaluate — don't hold up sign-up; let the flow continue.
        context.log("OnAttributeCollectionStart: no email identity in payload; continuing.");
        return continueResponse;
    }

    const blockReason = getEmailBlockReason(email);
    if (blockReason) {
        context.log(`OnAttributeCollectionStart: blocking '${email}'.`);
        return blockPageResponse("Registration blocked", blockReason);
    }

    context.log(`OnAttributeCollectionStart: '${email}' allowed; continuing.`);
    return continueResponse;
}

app.http("attributeCollectionStart", {
    methods: ["POST"],
    authLevel: "function",
    handler: attributeCollectionStart,
});
