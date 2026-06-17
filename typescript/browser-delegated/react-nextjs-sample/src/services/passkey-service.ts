import { passkeyApiBase } from "@/config/auth-config";

/**
 * Client for the local passkey proxy (passkey-proxy.mjs) plus the WebAuthn
 * ceremony itself. The proxy fronts the Microsoft Graph beta fido2Methods
 * provisioning APIs:
 *
 *   list     GET    /users/{oid}/authentication/fido2Methods
 *   options  GET    /users/{oid}/authentication/fido2Methods/creationOptions(...)
 *   register POST   /users/{oid}/authentication/fido2Methods
 *   delete   DELETE /users/{oid}/authentication/fido2Methods/{id}
 *
 * Every call is authenticated with the signed-in user's ID token; the proxy
 * verifies it and derives {oid} from it, so users can only touch their own
 * passkeys.
 */

/** UI-friendly view of a Graph fido2AuthenticationMethod. */
export interface PasskeyInfo {
    id: string;
    name: string;
    model: string;
    passkeyType: string;
    createdDateTime: string | null;
    lastUsedDateTime: string | null;
}

interface GraphFido2Method {
    id: string;
    displayName?: string;
    model?: string;
    passkeyType?: string;
    createdDateTime?: string;
    lastUsedDateTime?: string;
}

/**
 * WebAuthn creationOptions as returned by Graph (the `publicKey` member).
 * Binary fields arrive base64url-encoded and must be converted to ArrayBuffers
 * before they can be passed to navigator.credentials.create().
 */
interface GraphCreationOptions {
    challenge: string;
    timeout: number;
    rp: { id: string; name: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: PublicKeyCredentialParameters[];
    excludeCredentials: { id: string; type: string; transports?: string[] }[];
    authenticatorSelection: AuthenticatorSelectionCriteria;
    attestation: AttestationConveyancePreference;
}

/* ----------------------------- base64url helpers ----------------------------- */

function base64UrlToBuffer(value: string): ArrayBuffer {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Graph encodes excludeCredentials ids as base64url with the number of stripped
 * "=" padding characters appended as a trailing digit (e.g. "...xyz2" = two
 * padding chars). Decode back to raw bytes for the WebAuthn call.
 */
function decodeGraphCredentialId(id: string): ArrayBuffer {
    const match = id.match(/^(.*?)(\d)$/);
    if (!match) {
        throw new Error("Invalid Microsoft Graph credential id format");
    }
    const [, base, padCount] = match;
    const base64 = (base + "=".repeat(parseInt(padCount, 10)))
        .replace(/-/g, "+")
        .replace(/_/g, "/");
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}

/* ------------------------------- proxy client -------------------------------- */

async function callPasskeyApi(
    path: string,
    bearerToken: string,
    init: RequestInit = {}
): Promise<Response> {
    let response: Response;
    try {
        response = await fetch(`${passkeyApiBase}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${bearerToken}`,
                ...init.headers,
            },
        });
    } catch {
        throw new Error(
            "Could not reach the passkey proxy. Start it with `npm run passkey-proxy` (see README, Passkeys section)."
        );
    }

    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
            const body = await response.json();
            message = body?.error?.message ?? body?.error?.code ?? message;
        } catch {
            // keep the bare status message
        }
        throw new Error(message);
    }
    return response;
}

export async function fetchPasskeys(bearerToken: string): Promise<PasskeyInfo[]> {
    const response = await callPasskeyApi("/passkeys", bearerToken);
    const body: { value?: GraphFido2Method[] } = await response.json();
    return (body.value ?? []).map((method) => ({
        id: method.id,
        name: method.displayName || "Unnamed passkey",
        model: method.model || "Unknown model",
        passkeyType: method.passkeyType === "deviceBound" ? "Device-bound" : "Synced",
        createdDateTime: method.createdDateTime ?? null,
        lastUsedDateTime: method.lastUsedDateTime ?? null,
    }));
}

export async function fetchCreationOptions(bearerToken: string): Promise<GraphCreationOptions> {
    const response = await callPasskeyApi("/passkeys/creation-options", bearerToken);
    const body = await response.json();
    return body.publicKey as GraphCreationOptions;
}

/**
 * Run the browser's WebAuthn creation ceremony with the Graph-issued options.
 * Throws DOMException "NotAllowedError" when the user cancels / times out, or
 * "SecurityError" when the serving origin doesn't match rp.id.
 */
export async function createPasskeyCredential(
    options: GraphCreationOptions
): Promise<PublicKeyCredential> {
    const publicKey: PublicKeyCredentialCreationOptions = {
        challenge: base64UrlToBuffer(options.challenge),
        rp: { id: options.rp.id, name: options.rp.name },
        user: {
            id: base64UrlToBuffer(options.user.id),
            name: options.user.name,
            displayName: options.user.displayName,
        },
        pubKeyCredParams: options.pubKeyCredParams,
        excludeCredentials: options.excludeCredentials.map((credential) => ({
            type: "public-key" as const,
            id: decodeGraphCredentialId(credential.id),
            transports: credential.transports as AuthenticatorTransport[] | undefined,
        })),
        timeout: options.timeout,
        authenticatorSelection: options.authenticatorSelection,
        attestation: options.attestation,
    };

    const credential = await navigator.credentials.create({ publicKey });
    if (!credential) {
        throw new Error("The browser did not return a credential.");
    }
    return credential as PublicKeyCredential;
}

export async function registerPasskey(
    bearerToken: string,
    credential: PublicKeyCredential,
    displayName: string
): Promise<void> {
    const response = credential.response as AuthenticatorAttestationResponse;
    await callPasskeyApi("/passkeys", bearerToken, {
        method: "POST",
        body: JSON.stringify({
            displayName,
            publicKeyCredential: {
                id: credential.id,
                response: {
                    attestationObject: bufferToBase64Url(response.attestationObject),
                    clientDataJSON: bufferToBase64Url(response.clientDataJSON),
                },
            },
        }),
    });
}

export async function deletePasskey(bearerToken: string, passkeyId: string): Promise<void> {
    await callPasskeyApi(`/passkeys/${encodeURIComponent(passkeyId)}`, bearerToken, {
        method: "DELETE",
    });
}
