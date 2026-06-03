import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { validateSignUpAttributes, AttributeInput } from "../attributeValidation";

/**
 * Native-auth CORS proxy for Azure Static Web Apps.
 *
 * The CIAM native-authentication endpoints (https://<tenant>.ciamlogin.com/...)
 * do not return CORS headers, so a browser SPA cannot call them directly. Locally
 * this is solved by cors.js running on :3001; in production this SWA managed
 * function plays the same role at the site's own /api route. Because the SPA and
 * /api share an origin, no CORS headers are required at all.
 *
 * Every /api/<path> request is forwarded to <TENANT_BASE>/<path>, passing method,
 * headers (minus hop-by-hop), query string and body through unchanged — mirroring
 * proxy.config.js / cors.js.
 */

const TENANT_SUBDOMAIN = process.env.CIAM_TENANT_SUBDOMAIN || "myservicetasdevpoc";
const TENANT_ID = process.env.CIAM_TENANT_ID || "a67366e7-9873-4a38-9bae-0a4a18952688";
const TENANT_BASE = `https://${TENANT_SUBDOMAIN}.ciamlogin.com/${TENANT_ID}`;

// Hop-by-hop / fetch-managed headers we must not forward verbatim.
const STRIP_REQUEST_HEADERS = new Set(["host", "origin", "content-length", "connection"]);
const STRIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

export async function authProxy(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const path = request.params.path ?? "";

    // Server-side sign-up attribute validation (Option A). Native auth has no
    // OnAttributeCollectionSubmit hook, so this is the authoritative business-rule
    // check the client calls before submitAttributes(). Handled here rather than
    // forwarded upstream, because the catch-all route below otherwise proxies every
    // /api/* path to CIAM.
    if (path === "validate-attributes") {
        if (request.method.toUpperCase() !== "POST") {
            return { status: 405, jsonBody: { error: "Method not allowed." } };
        }
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return { status: 400, jsonBody: { valid: false, errors: {}, message: "Invalid request body." } };
        }
        return { status: 200, jsonBody: validateSignUpAttributes(body as AttributeInput) };
    }

    const query = request.query.toString();
    const targetUrl = `${TENANT_BASE}/${path}${query ? `?${query}` : ""}`;

    const headers = new Headers();
    request.headers.forEach((value, key) => {
        if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
            headers.set(key, value);
        }
    });

    const method = request.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;

    context.log(`proxy ${method} /api/${path} -> ${targetUrl}`);

    let upstream: Response;
    try {
        upstream = await fetch(targetUrl, { method, headers, body });
    } catch (error) {
        context.error("Upstream request to CIAM failed:", error);
        return { status: 502, jsonBody: { error: "Bad gateway: upstream request failed." } };
    }

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
        if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
            responseHeaders[key] = value;
        }
    });

    const responseBody = Buffer.from(await upstream.arrayBuffer());
    return { status: upstream.status, headers: responseHeaders, body: responseBody };
}

app.http("authProxy", {
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    authLevel: "anonymous",
    route: "{*path}",
    handler: authProxy,
});
