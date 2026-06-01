/**
 * Mock ServiceTas portal backend.
 *
 * In production these two functions become real HTTPS calls to the portal:
 *   - checkAccess   →  POST /Portal/checkAccess      (is this email allowed to sign up?)
 *   - createSignUp  →  POST /B2CPortal/createSignUp   (register the user in TFS)
 *
 * For the POC they are simulated locally so the OnAttributeCollectionSubmit
 * extension can be exercised end-to-end without the portal being reachable.
 * Each function keeps the same shape it will have once swapped for `fetch`,
 * so the handler in attributeCollectionSubmit.ts does not change.
 */

import type { InvocationContext } from "@azure/functions";

export interface AccessDecision {
    /** true → email may proceed; false → show a validation error. */
    allowed: boolean;
    /** Human-readable reason shown to the user when blocked. */
    reason?: string;
}

export interface SignUpResult {
    /** Identifier TFS assigns to the newly registered user. */
    tfsUserId: string;
}

// Parsed once from app settings. Comma-separated, case-insensitive.
const blockedEmails = parseList(process.env.BLOCKED_EMAILS);
const blockedDomains = parseList(process.env.BLOCKED_DOMAINS);

function parseList(value: string | undefined): Set<string> {
    return new Set(
        (value ?? "")
            .split(",")
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean)
    );
}

/**
 * Mock of POST /Portal/checkAccess.
 *
 * The real portal decides whether an email is permitted to register (e.g. it is
 * not already provisioned, not on a deny list, belongs to an eligible domain).
 * Here we deny any address on BLOCKED_EMAILS or whose domain is on
 * BLOCKED_DOMAINS; everything else is allowed.
 */
export async function checkAccess(email: string, context: InvocationContext): Promise<AccessDecision> {
    const normalized = email.trim().toLowerCase();
    const domain = normalized.split("@")[1] ?? "";

    if (blockedEmails.has(normalized)) {
        context.log(`checkAccess: '${email}' is on the blocked-email list.`);
        return { allowed: false, reason: "This email address isn't eligible to register. Please use a different one or contact support." };
    }

    if (domain && blockedDomains.has(domain)) {
        context.log(`checkAccess: domain '${domain}' is blocked.`);
        return { allowed: false, reason: `Email addresses from '${domain}' can't be used to register.` };
    }

    context.log(`checkAccess: '${email}' is allowed.`);
    return { allowed: true };

    // Production:
    // const res = await fetch(`${PORTAL_BASE}/Portal/checkAccess`, {
    //     method: "POST",
    //     headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    //     body: JSON.stringify({ email }),
    // });
    // const body = await res.json();
    // return { allowed: body.hasAccess, reason: body.message };
}

/**
 * Mock of POST /B2CPortal/createSignUp.
 *
 * The real endpoint creates the user record in TFS and returns its identifier.
 * Here we synthesize a deterministic id from the email so the call is idempotent
 * and log-friendly. Throwing simulates a backend outage so callers can map it to
 * a block page.
 */
export async function createSignUp(
    profile: { email: string; givenName?: string; surname?: string; displayName?: string },
    context: InvocationContext
): Promise<SignUpResult> {
    // A stable pseudo-id derived from the email — stands in for the TFS-assigned key.
    const tfsUserId = `tfs_${Buffer.from(profile.email.trim().toLowerCase()).toString("hex").slice(0, 16)}`;
    context.log(`createSignUp: registered '${profile.email}' in TFS as ${tfsUserId}.`);
    return { tfsUserId };

    // Production:
    // const res = await fetch(`${PORTAL_BASE}/B2CPortal/createSignUp`, {
    //     method: "POST",
    //     headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    //     body: JSON.stringify(profile),
    // });
    // if (!res.ok) throw new Error(`createSignUp failed: ${res.status}`);
    // const body = await res.json();
    // return { tfsUserId: body.userId };
}
