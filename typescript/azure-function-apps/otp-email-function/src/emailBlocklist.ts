/**
 * Server-side sign-up blocklist for the OnOtpSend extension.
 *
 * In native authentication, Entra never fires OnAttributeCollectionStart/Submit,
 * so this OnOtpSend hook is the EARLIEST server point at which we can stop a
 * blocked email from signing up — it fires before any code is sent. Because
 * OnOtpSend supports only `continueWithDefaultBehavior` (there is no
 * `showBlockPage` action), the caller "blocks" by returning a non-success HTTP
 * response and not sending the email; the friendly message is shown client-side.
 *
 * This logic is duplicated in three places that MUST be kept in sync:
 *   1. otp-email-function/src/emailBlocklist.ts           (this file — native + browser enforcement)
 *   2. attribute-start-function/src/emailBlocklist.ts     (browser-flow secondary guard)
 *   3. react-nextjs-sample/src/app/shared/utils/emailBlocklist.ts (client UX)
 * The two Azure Functions are separate Node projects with no shared package, so
 * the list is copied rather than imported.
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
 * accepted the address by this point, so we don't second-guess its format.
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
