import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getUserMfaPhoneNumber, getUserSignInEmail } from "../graphClient";

/**
 * Entra External ID "OnTokenIssuanceStart" (tokenIssuanceStart) custom claims provider.
 *
 * Entra raises this event just before a token is issued to the app. This function
 * reads from Microsoft Graph (by the authenticating user's `oid`) and returns two
 * custom claims:
 *   - phoneNumber: the MFA phone number, which lives in the authentication-methods
 *     store (authentication/phoneMethods), NOT as a directory profile attribute,
 *     so it can't be surfaced through the normal Attributes & Claims mapping.
 *   - signInEmail: the user's current directory email (`mail`). The built-in
 *     `email`/`preferred_username` claims are derived from the credential the user
 *     authenticated with, so they go stale when the sign-in email is changed but
 *     an older credential (e.g. a passkey) is used to sign in. Reading by `oid`
 *     here is auth-method independent, so the claim is consistent across methods.
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

// The claim names (ClaimsSchema "ID") this function returns. Must match the
// claims mapping policy exactly — the ID comparison is case sensitive.
const phoneClaimId = process.env.PHONE_CLAIM_ID || "phoneNumber";
const emailClaimId = process.env.EMAIL_CLAIM_ID || "signInEmail";

// Deadline for the Graph lookup. Entra caps the whole callout at ~2s and the
// phoneMethods endpoint alone routinely takes 1-2.5s, so without this bound a
// slow Graph day fails the entire sign-in (1003005 CustomExtensionTimedOut).
// Past the deadline we abort Graph and issue the token without the claim.
const graphTimeoutMs = Number(process.env.GRAPH_TIMEOUT_MS) || 1800;

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

    // Log a failed read and swallow it: a Graph hiccup or a blown deadline on one
    // lookup must not block token issuance, nor drop the other claim. (Entra can
    // also be configured to fall back to default behavior on error via the
    // listener config.)
    const onReadError = (label: string) => (error: unknown) => {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
            context.warn(
                `Graph ${label} lookup exceeded ${graphTimeoutMs}ms (total ${Date.now() - start}ms); ` +
                    "issuing the token without that claim."
            );
        } else {
            context.error(`Failed to read ${label} from Graph:`, error);
        }
        return undefined;
    };

    // Both reads share one deadline and run concurrently — the token credential
    // caches the access token, so the second call reuses it and only the two
    // Graph fetches overlap, keeping the whole callout inside Entra's budget.
    const deadline = AbortSignal.timeout(graphTimeoutMs);
    const [phoneNumber, signInEmail] = await Promise.all([
        getUserMfaPhoneNumber(userId, (m) => context.log(m), deadline).catch(
            onReadError("MFA phone number")
        ),
        getUserSignInEmail(userId, (m) => context.log(m), deadline).catch(
            onReadError("sign-in email")
        ),
    ]);
    context.log(`Graph reads total: ${Date.now() - start}ms.`);

    // Issue whichever claims resolved; an absent value is omitted rather than
    // failing the sign-in. The client falls back to the built-in claims.
    const claims: Record<string, string> = {};
    if (phoneNumber) claims[phoneClaimId] = phoneNumber;
    else context.log("No MFA phone method found for user; omitting phone claim.");
    if (signInEmail) claims[emailClaimId] = signInEmail;
    else context.log("No directory mail found for user; omitting sign-in email claim.");

    context.log(`Claims added to token: ${Object.keys(claims).join(", ") || "(none)"}.`);
    return claimsResponse(claims);
}

app.http("tokenIssuanceStart", {
    methods: ["POST"],
    authLevel: "function",
    handler: tokenIssuanceStart,
});
