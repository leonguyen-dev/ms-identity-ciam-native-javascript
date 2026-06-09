import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

/**
 * Entra External ID "OnAttributeCollectionSubmit" custom authentication extension.
 *
 * Entra POSTs the attributes the user submitted on the sign-up page. This function:
 *   1. validates the collected dateOfBirth attribute — must be a real calendar date
 *      (DD/MM/YYYY) for someone at least 16 years old. A failure returns
 *      `showValidationError` keyed to the attribute so the hosted page re-prompts the
 *      user inline.
 *   2. returns `continueWithDefaultBehavior` so Entra completes the sign-up.
 *
 * Auth: protect this endpoint with the Function App's built-in Authentication
 * (Easy Auth) wired to the "On Attribute Collection Submit API Authentication" app
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

// Re-prompt the user with a field-level error keyed to the offending attribute.
// `attributeErrors` keys must match the attribute names exactly as Entra sent them
// (custom attributes arrive prefixed, e.g. extension_<appid>_dateOfBirth).
function validationErrorResponse(attributeErrors: Record<string, string>, message: string): HttpResponseInit {
    return {
        status: 200,
        jsonBody: {
            data: {
                "@odata.type": RESPONSE_DATA_TYPE,
                actions: [
                    {
                        "@odata.type": "microsoft.graph.attributeCollectionSubmit.showValidationError",
                        message,
                        attributeErrors,
                    },
                ],
            },
        },
    };
}

function asString(value: AttributeValue | undefined): string | undefined {
    return typeof value?.value === "string" ? value.value : undefined;
}

const MIN_AGE = 16;

// Whole years between `dob` and `now`, computed in UTC so a local timezone can't
// shift the result by a day either side of a birthday.
function ageOn(dob: Date, now: Date): number {
    let age = now.getUTCFullYear() - dob.getUTCFullYear();
    const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
    if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
        age--;
    }
    return age;
}

// Validate the collected date of birth. The hosted sign-up page submits it as
// D/M/YYYY or DD/MM/YYYY (day-first). Returns an error message to show the user,
// or null if the value is a real calendar date for someone at least MIN_AGE.
function validateDateOfBirth(value: string | undefined): string | null {
    if (!value || value.trim().length === 0) {
        return "Please provide your date of birth.";
    }

    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
    if (!match) {
        return "Please enter your date of birth as DD/MM/YYYY.";
    }

    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const dob = new Date(Date.UTC(year, month - 1, day));

    // Reject impossible dates that the Date constructor silently rolls over
    // (e.g. 31/02/2020 would otherwise become 02/03/2020).
    if (dob.getUTCFullYear() !== year || dob.getUTCMonth() !== month - 1 || dob.getUTCDate() !== day) {
        return "Please enter a valid date of birth.";
    }

    const now = new Date();
    if (dob.getTime() > now.getTime()) {
        return "Your date of birth can't be in the future.";
    }

    if (ageOn(dob, now) < MIN_AGE) {
        return `You must be at least ${MIN_AGE} years old to register.`;
    }

    return null;
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

    const attributes = payload.data?.userSignUpInfo?.attributes ?? {};

    // 1. Date-of-birth validation. The attribute name is prefixed for custom
    //    attributes (extension_<appid>_dateOfBirth), so match by suffix and key the
    //    error back to the exact name Entra sent.
    const dobKey = Object.keys(attributes).find((key) => key.toLowerCase().endsWith("dateofbirth"));
    const dobError = validateDateOfBirth(dobKey ? asString(attributes[dobKey]) : undefined);
    if (dobError) {
        return validationErrorResponse(
            { [dobKey ?? "dateOfBirth"]: dobError },
            "Please fix the highlighted fields to continue."
        );
    }

    // 2. Success — let Entra complete the sign-up.
    return continueResponse;
}

app.http("attributeCollectionSubmit", {
    methods: ["POST"],
    authLevel: "function",
    handler: attributeCollectionSubmit,
});
