import {
    ClientSecretCredential,
    ManagedIdentityCredential,
    type TokenCredential,
} from "@azure/identity";

/**
 * Minimal Microsoft Graph helper for reading a user's registered phone-based
 * authentication methods (the SMS number captured during MFA setup).
 *
 * The MFA phone number is NOT a directory profile attribute — it lives in the
 * authentication-methods store and is only reachable via Graph:
 *   GET /users/{id}/authentication/phoneMethods
 *
 * App-only access requires the application permission
 * `UserAuthenticationMethod.Read.All` (admin-consented).
 *
 * Credential selection (managed identity in Azure, client secret locally):
 *   - If GRAPH_CLIENT_SECRET is set, use a client secret (local/dev). Requires
 *     GRAPH_TENANT_ID + GRAPH_CLIENT_ID too.
 *   - Otherwise use the Function App's managed identity. Grant that identity the
 *     `UserAuthenticationMethod.Read.All` Graph app role (via Graph/PowerShell —
 *     app-role assignments to managed identities aren't available in the portal).
 *     For a user-assigned identity, set GRAPH_MANAGED_IDENTITY_CLIENT_ID.
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

let cachedCredential: TokenCredential | undefined;

function getCredential(): TokenCredential {
    if (cachedCredential) return cachedCredential;

    const clientSecret = process.env.GRAPH_CLIENT_SECRET;

    if (clientSecret) {
        const tenantId = process.env.GRAPH_TENANT_ID;
        const clientId = process.env.GRAPH_CLIENT_ID;
        if (!tenantId || !clientId) {
            throw new Error(
                "GRAPH_CLIENT_SECRET is set but GRAPH_TENANT_ID and/or GRAPH_CLIENT_ID are missing."
            );
        }
        // Credentials cache and refresh tokens internally, so reuse one instance.
        cachedCredential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    } else {
        // No secret → managed identity (the Azure path). Pass a client ID only
        // for a user-assigned identity; omit it for system-assigned.
        const miClientId = process.env.GRAPH_MANAGED_IDENTITY_CLIENT_ID;
        cachedCredential = miClientId
            ? new ManagedIdentityCredential({ clientId: miClientId })
            : new ManagedIdentityCredential();
    }

    return cachedCredential;
}

// Shape of a phoneMethods entry. phoneType is "mobile" | "alternateMobile" | "office".
// See https://learn.microsoft.com/graph/api/resources/phoneauthenticationmethod
interface PhoneAuthenticationMethod {
    id: string;
    phoneNumber: string;
    phoneType?: string;
}

interface PhoneMethodsResponse {
    value?: PhoneAuthenticationMethod[];
}

/**
 * Returns the user's mobile MFA phone number (E.164, e.g. "+1 2065551234"),
 * or undefined if the user has no registered phone method.
 */
export async function getUserMfaPhoneNumber(
    userId: string,
    log?: (message: string) => void
): Promise<string | undefined> {
    // Timing breakdown helps diagnose CustomExtensionTimedOut (error 1003005):
    // Entra allows ~2s. Slow token acquisition points at a cold start (the
    // credential is rebuilt per cold instance); a slow Graph call points at a
    // downstream/network issue. Warm requests should show a cached-token hit.
    const tokenStart = Date.now();
    const token = await getCredential().getToken(GRAPH_SCOPE);
    log?.(`Graph token acquired in ${Date.now() - tokenStart}ms.`);
    if (!token) {
        throw new Error("Failed to acquire a Microsoft Graph access token.");
    }

    const callStart = Date.now();
    const response = await fetch(
        `${GRAPH_BASE}/users/${encodeURIComponent(userId)}/authentication/phoneMethods`,
        { headers: { Authorization: `Bearer ${token.token}` } }
    );
    log?.(`Graph phoneMethods call returned ${response.status} in ${Date.now() - callStart}ms.`);

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Graph phoneMethods call failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as PhoneMethodsResponse;
    const methods = data.value ?? [];

    // Prefer the primary mobile number; fall back to the first registered method.
    const mobile = methods.find((m) => m.phoneType === "mobile");
    return (mobile ?? methods[0])?.phoneNumber;
}
