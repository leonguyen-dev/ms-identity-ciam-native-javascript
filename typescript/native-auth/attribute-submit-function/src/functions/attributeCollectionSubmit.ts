import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { checkAccess, createSignUp } from "../mockBackend";

/**
 * Entra External ID "OnAttributeCollectionSubmit" custom authentication extension.
 *
 * Entra POSTs the attributes the user submitted on the sign-up page (plus their
 * verified email identity). This function:
 *   1. validates the email against the ServiceTas portal — mock of /Portal/checkAccess.
 *      A blocked email returns `showBlockPage`, stopping the sign-up with a
 *      full-page message. (It deliberately does NOT use `showValidationError`: the
 *      email is a verified identity, not a collected attribute, so a validation
 *      error keyed to it is dropped by native auth and rejected by the hosted flow.
 *      See README.)
 *   2. registers the user in TFS — mock of /B2CPortal/createSignUp.
 *   3. returns `continueWithDefaultBehavior` so Entra completes the sign-up.
 *
 * Both backend calls are mocked in ../mockBackend for the POC; swap them for real
 * HTTPS calls without touching this handler.
 *
 * Auth: protect this endpoint with the Function App's built-in Authentication
 * (Easy Auth) wired to the "Azure Functions authentication events API" app
 * registration, per the Microsoft setup guide. The `function` authLevel key is a
 * second factor but is not a substitute for token validation in production.
 *
 * Schema: https://learn.microsoft.com/entra/identity-platform/custom-extension-onattributecollectionsubmit-retrieve-return-data
 */

const RESPONSE_DATA_TYPE = "microsoft.graph.onAttributeCollectionSubmitResponseData";

// Shape of the slice of the Entra payload we consume.
interface AttributeValue {
    value?: string | number | boolean;
}

interface Identity {
    signInType?: string;
    issuer?: string;
    issuerAssignedId?: string;
}

interface OnAttributeCollectionSubmitPayload {
    data?: {
        userSignUpInfo?: {
            attributes?: Record<string, AttributeValue>;
            identities?: Identity[];
        };
    };
}

// Tell Entra to proceed with the default sign-up behavior.
const continueResponse: HttpResponseInit = {
    status: 200,
    jsonBody: {
        data: {
            "@odata.type": RESPONSE_DATA_TYPE,
            actions: [{ "@odata.type": "microsoft.graph.attributeCollectionSubmit.continueWithDefaultBehavior" }],
        },
    },
};

// Stop the sign-up with a full-page message (a blocked email or a backend failure).
function blockPageResponse(title: string, message: string): HttpResponseInit {
    return {
        status: 200,
        jsonBody: {
            data: {
                "@odata.type": RESPONSE_DATA_TYPE,
                actions: [
                    {
                        "@odata.type": "microsoft.graph.attributeCollectionSubmit.showBlockPage",
                        title,
                        message,
                    },
                ],
            },
        },
    };
}

function asString(value: AttributeValue | undefined): string | undefined {
    return typeof value?.value === "string" ? value.value : undefined;
}

export async function attributeCollectionSubmit(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    let payload: OnAttributeCollectionSubmitPayload;
    try {
        payload = (await request.json()) as OnAttributeCollectionSubmitPayload;
    } catch {
        return { status: 400, jsonBody: { error: "Invalid JSON body." } };
    }

    const userInfo = payload.data?.userSignUpInfo;
    const attributes = userInfo?.attributes ?? {};

    // The verified email arrives as an "email" identity, not as an attribute.
    const email = userInfo?.identities?.find((id) => id.signInType === "email")?.issuerAssignedId;
    if (!email) {
        return { status: 400, jsonBody: { error: "Missing email identity in userSignUpInfo.identities." } };
    }

    // 1. Email validation — mock of /Portal/checkAccess.
    let decision;
    try {
        decision = await checkAccess(email, context);
    } catch (error) {
        context.error("checkAccess failed:", error);
        return blockPageResponse("We couldn't verify your details", "Sign-up is temporarily unavailable. Please try again later.");
    }

    if (!decision.allowed) {
        return blockPageResponse(
            "Registration blocked",
            decision.reason ?? "This email address can't be used to register."
        );
    }

    // 2. TFS user registration — mock of /B2CPortal/createSignUp.
    try {
        const { tfsUserId } = await createSignUp(
            {
                email,
                givenName: asString(attributes.givenName),
                surname: asString(attributes.surname),
                displayName: asString(attributes.displayName),
            },
            context
        );
        context.log(`Sign-up registered in TFS (tfsUserId=${tfsUserId}); continuing flow.`);
    } catch (error) {
        context.error("createSignUp failed:", error);
        return blockPageResponse("Registration couldn't be completed", "We couldn't finish setting up your account. Please try again later.");
    }

    // 3. Success — let Entra complete the sign-up.
    return continueResponse;
}

app.http("attributeCollectionSubmit", {
    methods: ["POST"],
    authLevel: "function",
    handler: attributeCollectionSubmit,
});
