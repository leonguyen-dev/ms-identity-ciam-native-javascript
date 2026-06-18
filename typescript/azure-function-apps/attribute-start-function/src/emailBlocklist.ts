/**
 * Server-side sign-up blocklist for the OnAttributeCollectionStart extension.
 *
 * This is the AUTHORITATIVE enforcement of the email blocklist: it runs inside
 * Entra's sign-up flow and can't be bypassed by calling the native-auth API
 * directly. The React client keeps a matching list for instant UX
 * (react-nextjs-sample/src/app/shared/utils/emailBlocklist.ts) — keep the two in
 * sync.
 *
 * Lists come from app settings (comma-separated, case-insensitive, whitespace
 * trimmed):
 *   BLOCKED_EMAILS  - exact addresses, e.g. "a@x.com,b@y.com"
 *   BLOCKED_DOMAINS - domains incl. subdomains, e.g. "mailinator.com"
 */

function parseList(value: string | undefined): string[] {
    return (value ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}

// Parsed once at module load from app settings.
const blockedEmailSet = new Set(parseList(process.env.BLOCKED_EMAILS));
const blockedDomains = parseList(process.env.BLOCKED_DOMAINS);

/**
 * Returns a user-facing error message if the email is blocked, or null if it's
 * allowed to proceed. Malformed input (no "@") returns null — Entra has already
 * verified the address by this point, so we don't second-guess its format.
 */
export function getEmailBlockReason(email: string): string | null {
    const normalized = email.trim().toLowerCase();
    const atIndex = normalized.lastIndexOf("@");
    if (atIndex === -1) {
        return null;
    }

    if (blockedEmailSet.has(normalized)) {
        return "This email address can't be used to sign up for myServiceTas. Please use a different email address.";
    }

    const domain = normalized.slice(atIndex + 1);
    const domainBlocked = blockedDomains.some(
        (blocked) => domain === blocked || domain.endsWith(`.${blocked}`)
    );
    if (domainBlocked) {
        return "Email addresses from this domain can't be used to sign up for myServiceTas. Please use a different email address.";
    }

    return null;
}
