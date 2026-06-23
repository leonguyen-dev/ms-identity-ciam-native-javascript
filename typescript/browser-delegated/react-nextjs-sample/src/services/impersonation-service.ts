import { impersonationApiBase, impersonationViewBase } from "@/config/auth-config";

/**
 * Client for the impersonation portal routes on the local proxy (local-proxy.mjs),
 * Feature B / B4 — the RWVP "sign in as a customer" support portal.
 *
 * External ID has no supported way to issue a token AS another customer, so
 * impersonation is modelled at the application/session layer (plan B4.1): an
 * RBAC-gated admin action mints a signed HttpOnly *app* session — never an Entra
 * token — that records both the acting admin and the impersonated subject. The
 * proxy enforces the admin allow-list, the read-only scope, the bounded TTL,
 * revocation, and the audit log (plan B4.2). See impersonation-portal-design.md.
 *
 *   start   POST /api/impersonation/start    admin Bearer; mint a session (RBAC)
 *   whoami  GET  /api/impersonation/whoami    cookie-based; current session or 401
 *   stop    POST /api/impersonation/stop      cookie-based; end the session
 *   revoke  POST /api/impersonation/revoke    admin Bearer; kill a session by id
 *   audit   GET  /api/impersonation/audit     admin Bearer; active + audit log
 *
 * whoami/stop ride the HttpOnly impersonation cookie, so they use
 * `credentials: "include"` and no Bearer token; start/revoke/audit are gated on
 * the admin's verified ID token.
 */

export interface ImpersonationIdentity {
    oid: string | null;
    email: string | null;
    name?: string | null;
}

export interface ImpersonationSession {
    sessionId: string;
    actor: ImpersonationIdentity;
    subject: ImpersonationIdentity;
    reason: string | null;
    scope: string | null;
    startedAt: number;
    expiresAt: number;
}

export interface ImpersonationAuditEntry {
    action: "start" | "stop" | "revoke";
    sessionId: string;
    actor: ImpersonationIdentity;
    subject: ImpersonationIdentity;
    reason: string | null;
    scope: string | null;
    at: string;
}

/** Error from the proxy, carrying its machine-readable code (e.g. "not_admin"). */
export class ImpersonationApiError extends Error {
    constructor(message: string, public readonly code?: string) {
        super(message);
        this.name = "ImpersonationApiError";
    }
}

async function callImpersonationApi(
    path: string,
    init: RequestInit = {},
    bearerToken?: string
): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(`${impersonationApiBase()}${path}`, {
            ...init,
            // The HttpOnly impersonation cookie must be sent/stored across these
            // calls (whoami/stop rely on it; start sets it).
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
                ...init.headers,
            },
        });
    } catch {
        throw new ImpersonationApiError(
            "Could not reach the local proxy. Start it with `npm run proxy` (see README, 'Impersonation portal' section)."
        );
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        body = undefined;
    }

    if (!response.ok) {
        const err = body as { error?: { message?: string; code?: string } } | undefined;
        throw new ImpersonationApiError(
            err?.error?.message ?? err?.error?.code ?? `HTTP ${response.status}`,
            err?.error?.code
        );
    }
    return body;
}

/** Start impersonating a customer. Admin-gated; needs a justification (reason). */
export async function startImpersonation(
    bearerToken: string,
    subjectEmail: string,
    reason: string
): Promise<ImpersonationSession> {
    const body = (await callImpersonationApi(
        "/impersonation/start",
        { method: "POST", body: JSON.stringify({ subjectEmail, reason }) },
        bearerToken
    )) as { session: ImpersonationSession };
    return body.session;
}

/**
 * Read the currently-active impersonation session from the HttpOnly cookie.
 * Returns null when there is none (the proxy answers 401 with code "no_session").
 */
export async function fetchActiveImpersonation(): Promise<ImpersonationSession | null> {
    try {
        const body = (await callImpersonationApi("/impersonation/whoami")) as {
            session: ImpersonationSession;
        };
        return body.session;
    } catch (err) {
        if (err instanceof ImpersonationApiError && err.code === "no_session") return null;
        throw err;
    }
}

/** End the active impersonation session (clears the cookie). Idempotent. */
export async function stopImpersonation(): Promise<void> {
    await callImpersonationApi("/impersonation/stop", { method: "POST" });
}

/** Revoke a live session by id (admin-gated) — cuts it off even from elsewhere. */
export async function revokeImpersonation(bearerToken: string, sessionId: string): Promise<void> {
    await callImpersonationApi(
        "/impersonation/revoke",
        { method: "POST", body: JSON.stringify({ sessionId }) },
        bearerToken
    );
}

export interface ImpersonationAudit {
    active: ImpersonationSession[];
    log: ImpersonationAuditEntry[];
}

/** Read the audit trail + currently-live sessions (admin-gated). */
export async function fetchImpersonationAudit(bearerToken: string): Promise<ImpersonationAudit> {
    return (await callImpersonationApi(
        "/impersonation/audit",
        { method: "GET" },
        bearerToken
    )) as ImpersonationAudit;
}

/** URL of the impersonated-view content to load in the portal's iframe. */
export function impersonationViewUrl(
    path: "/impersonate-view" | "/impersonate-view/profile" = "/impersonate-view"
): string {
    return `${impersonationViewBase()}${path}`;
}
