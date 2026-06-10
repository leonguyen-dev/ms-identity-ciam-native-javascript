import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getUserMfaPhoneNumber } from "../graphClient";

/**
 * Entra External ID "OnTokenIssuanceStart" (tokenIssuanceStart) custom claims provider.
 *
 * Entra raises this event just before a token is issued to the app. The MFA
 * phone number a user registers during MFA setup is stored as an authentication
 * method, NOT as a directory profile attribute, so it can't be surfaced through
 * the normal Attributes & Claims mapping. This function reads it from Microsoft
 * Graph (authentication/phoneMethods) and returns it as a custom claim.
 *
 * Returning a claim here is not sufficient on its own: a claims mapping policy
 * must also be assigned to the app for the value to land in the token. See
 * claims-mapping-policy.json and the README.
 *
 * Auth: protect this endpoint with the Function App's built-in Authentication
 * (Easy Auth) wired to the "Azure Functions authentication events API" app
 * registration, per the Microsoft setup guide. The `function` authLevel key is a
 * second factor but is not a substitute for token validation in production.
 */

// The claim name (ClaimsSchema "ID") this function returns. Must match the
// claims mapping policy exactly — the ID comparison is case sensitive.
const phoneClaimId = process.env.PHONE_CLAIM_ID || "phoneNumber";

// Deadline for the Graph lookup. Entra caps the whole callout at ~2s and the
// phoneMethods endpoint alone routinely takes 1-2.5s, so without this bound a
// slow Graph day fails the entire sign-in (1003005 CustomExtensionTimedOut).
// Past the deadline we abort Graph and issue the token without the claim.
const graphTimeoutMs = Number(process.env.GRAPH_TIMEOUT_MS) || 1900;

// Shape of the slice of the Entra payload we consume. See:
// https://learn.microsoft.com/entra/identity-platform/custom-claims-provider-reference
interface OnTokenIssuanceStartPayload {
    data?: {
        authenticationContext?: {
            user?: {
                id?: string;
            };
        };
    };
}

// Build the response Entra expects. Pass an empty object to add no claims.
function claimsResponse(claims: Record<string, string | string[]>): HttpResponseInit {
    return {
        status: 200,
        jsonBody: {
            data: {
                "@odata.type": "microsoft.graph.onTokenIssuanceStartResponseData",
                actions: [
                    {
                        "@odata.type": "microsoft.graph.tokenIssuanceStart.provideClaimsForToken",
                        claims,
                    },
                ],
            },
        },
    };
}

export async function tokenIssuanceStart(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    let payload: OnTokenIssuanceStartPayload;
    try {
        payload = (await request.json()) as OnTokenIssuanceStartPayload;
    } catch {
        return { status: 400, jsonBody: { error: "Invalid JSON body." } };
    }

    const userId = payload.data?.authenticationContext?.user?.id;
    if (!userId) {
        return { status: 400, jsonBody: { error: "Missing authenticationContext.user.id." } };
    }

    // Total handler time vs. the Graph sub-timings (logged inside the client)
    // reveals cold-start overhead: if the total is far larger than token + call,
    // the instance was cold. Entra's budget for this call is ~2s.
    const start = Date.now();
    try {
        const phoneNumber = await getUserMfaPhoneNumber(
            userId,
            (m) => context.log(m),
            AbortSignal.timeout(graphTimeoutMs)
        );
        context.log(`getUserMfaPhoneNumber total: ${Date.now() - start}ms.`);

        if (!phoneNumber) {
            // No registered phone method — issue the token without the claim
            // rather than failing the sign-in.
            context.log("No MFA phone method found for user; returning no claim.");
            return claimsResponse({});
        }

        context.log("MFA phone claim added to token.");
        return claimsResponse({ [phoneClaimId]: phoneNumber });
    } catch (error) {
        // Don't block token issuance on a Graph hiccup or a blown deadline.
        // Entra can also be set to fall back to the default behavior on error
        // via the listener config.
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
            context.warn(
                `Graph lookup exceeded ${graphTimeoutMs}ms (total ${Date.now() - start}ms); ` +
                    "issuing the token without the phone claim."
            );
        } else {
            context.error("Failed to read MFA phone number from Graph:", error);
        }
        return claimsResponse({});
    }
}

app.http("tokenIssuanceStart", {
    methods: ["POST"],
    authLevel: "function",
    handler: tokenIssuanceStart,
});
