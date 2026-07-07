import { customAuthConfig } from "@/config/auth-config";

export interface AttributeValidationResult {
    valid: boolean;
    errors: Record<string, string>;
    message?: string;
}

export interface AttributeValidationPayload {
    givenName: string;
    surname: string;
    dateOfBirth: string;
    termsAccepted: boolean;
}

/**
 * Calls the server-side attribute validation endpoint (Option A).
 *
 * Native auth has no OnAttributeCollectionSubmit extension, so the authoritative
 * business-rule validation lives behind the /api proxy (api/src/attributeValidation.ts,
 * mirrored in cors.js for local dev). DetailsStep validates the same rules client-side
 * for fast feedback; this is the server check run immediately before submitAttributes().
 *
 * Fails CLOSED: if the endpoint is unreachable or errors, we return valid:false with a
 * retryable message rather than silently admitting unvalidated data. (Flip the catch/
 * non-ok branches to `valid:true` if you'd rather a proxy blip never blocks sign-up.)
 */
export async function validateSignUpAttributesRemote(
    payload: AttributeValidationPayload
): Promise<AttributeValidationResult> {
    const base = customAuthConfig.customAuth.authApiProxyUrl;
    const retryable: AttributeValidationResult = {
        valid: false,
        errors: {},
        message: "We couldn't verify your details right now. Please try again.",
    };

    try {
        const res = await fetch(`${base}/validate-attributes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            return retryable;
        }
        return (await res.json()) as AttributeValidationResult;
    } catch {
        return retryable;
    }
}
