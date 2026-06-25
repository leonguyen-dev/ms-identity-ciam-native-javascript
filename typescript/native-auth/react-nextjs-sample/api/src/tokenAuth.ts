import crypto from "crypto";

/**
 * Shared CIAM token verification for the SWA managed function.
 *
 * Both the webview SSO routes (webview.ts) and the account self-management routes
 * (account.ts) need to validate a CIAM bearer token's signature/iss/aud/tid/exp
 * against the tenant JWKS. That logic lives here so the two callers stay in sync;
 * each one just pulls the raw token out of its own custom request header (Azure
 * Static Web Apps clobbers `Authorization` with its own platform token, so a CIAM
 * bearer placed there never survives — see reference_swa_authorization_header_clobber)
 * and hands the string to verifyCiamToken().
 */

export const TENANT_SUBDOMAIN = process.env.CIAM_TENANT_SUBDOMAIN || "myservicetasdevpoc";
export const TENANT_ID = process.env.CIAM_TENANT_ID || "a67366e7-9873-4a38-9bae-0a4a18952688";
export const CLIENT_ID = process.env.CIAM_CLIENT_ID || "5f0a52ca-f5db-4a6d-9b3a-3180d51fdd08";
const CLOCK_SKEW_SECONDS = 5 * 60;

export class HttpError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
        super(message);
        this.status = status;
        this.code = code; // machine-readable hint for the SPA (e.g. "mfa_required")
    }
}

export interface TokenClaims {
    oid?: string;
    iss?: string;
    aud?: string;
    tid?: string;
    exp?: number;
    nbf?: number;
    iat?: number;
    amr?: string[];
    name?: string;
    email?: string;
    signin_email?: string;
    preferred_username?: string;
}

interface OidcMetadata {
    issuer: string;
    keys: Array<crypto.JsonWebKey & { kid?: string }>;
    fetchedAt: number;
}

let oidcMetadata: OidcMetadata | null = null;

async function getOidcMetadata(forceKeyRefresh = false): Promise<OidcMetadata> {
    const oneHour = 60 * 60 * 1000;
    if (oidcMetadata && !forceKeyRefresh && Date.now() - oidcMetadata.fetchedAt < oneHour) {
        return oidcMetadata;
    }
    const configUrl = `https://${TENANT_SUBDOMAIN}.ciamlogin.com/${TENANT_ID}/v2.0/.well-known/openid-configuration`;
    const configResponse = await fetch(configUrl);
    if (!configResponse.ok) {
        throw new HttpError(502, `Could not fetch OIDC metadata (HTTP ${configResponse.status}).`);
    }
    const config = (await configResponse.json()) as { issuer?: string; jwks_uri?: string };
    if (!config.issuer || !config.jwks_uri) {
        throw new HttpError(502, "OIDC metadata is missing issuer/jwks_uri.");
    }
    const jwksResponse = await fetch(config.jwks_uri);
    if (!jwksResponse.ok) {
        throw new HttpError(502, `Could not fetch tenant JWKS (HTTP ${jwksResponse.status}).`);
    }
    const jwks = (await jwksResponse.json()) as { keys?: OidcMetadata["keys"] };
    oidcMetadata = { issuer: config.issuer, keys: jwks.keys ?? [], fetchedAt: Date.now() };
    return oidcMetadata;
}

/**
 * Validate a raw CIAM bearer token against the tenant JWKS; return its claims.
 * Throws HttpError(401) on any failure. The caller is responsible for pulling the
 * token out of whatever header it arrived in.
 */
export async function verifyCiamToken(token: string | null | undefined): Promise<TokenClaims> {
    if (!token) throw new HttpError(401, "Missing token.");

    const parts = token.split(".");
    if (parts.length !== 3) throw new HttpError(401, "Malformed token.");
    const [headerB64, payloadB64, signatureB64] = parts;

    let header: { kid?: string };
    let payload: TokenClaims;
    try {
        header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
        payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch {
        throw new HttpError(401, "Malformed token.");
    }

    let metadata = await getOidcMetadata();
    let jwk = metadata.keys.find((key) => key.kid === header.kid);
    if (!jwk) {
        // Key rollover — refetch the JWKS once before giving up.
        metadata = await getOidcMetadata(true);
        jwk = metadata.keys.find((key) => key.kid === header.kid);
        if (!jwk) throw new HttpError(401, "Unknown signing key.");
    }

    const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
    const signatureValid = crypto.verify(
        "RSA-SHA256",
        Buffer.from(`${headerB64}.${payloadB64}`),
        publicKey,
        Buffer.from(signatureB64, "base64url")
    );
    if (!signatureValid) throw new HttpError(401, "Invalid token signature.");

    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== metadata.issuer) throw new HttpError(401, "Invalid token issuer.");
    if (payload.aud !== CLIENT_ID) throw new HttpError(401, "Invalid token audience.");
    if (payload.tid !== TENANT_ID) throw new HttpError(401, "Invalid token tenant.");
    if ((payload.exp ?? 0) < now - CLOCK_SKEW_SECONDS) throw new HttpError(401, "Token expired.");
    if ((payload.nbf ?? 0) > now + CLOCK_SKEW_SECONDS) throw new HttpError(401, "Token not yet valid.");
    if (!payload.oid) throw new HttpError(401, "Token has no oid claim.");

    return payload;
}
