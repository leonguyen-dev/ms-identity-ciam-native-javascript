/**
 * Client-side sign-up blocklist.
 *
 * This is a UX convenience only: it shows the user an error the moment they
 * submit their email, before we call signUp() (so no verification code is ever
 * sent to a blocked address). It is NOT a security boundary — the native-auth
 * API can be called directly, bypassing this check. The authoritative block is
 * enforced server-side by the OnAttributeCollectionStart custom authentication
 * extension. Keep the two lists in sync.
 *
 * Entries are matched case-insensitively. Surrounding whitespace is ignored.
 */

// Exact email addresses to block, e.g. "blocked.user@example.com".
const BLOCKED_EMAILS: string[] = [
    "someone@example.com",
];

// Domains to block. Matches the domain itself and any subdomain
const BLOCKED_DOMAINS: string[] = [
    "a.c",
];

const BLOCKED_EMAIL_SET = new Set(BLOCKED_EMAILS.map((e) => e.trim().toLowerCase()));
const NORMALIZED_DOMAINS = BLOCKED_DOMAINS.map((d) => d.trim().toLowerCase());

/**
 * Returns a user-facing error message if the email is blocked, or null if it's
 * allowed to proceed. Malformed input returns null — the email-format check in
 * EmailStep handles that case.
 */
export function getEmailBlockReason(email: string): string | null {
    const normalized = email.trim().toLowerCase();
    const atIndex = normalized.lastIndexOf("@");
    if (atIndex === -1) {
        return null;
    }

    if (BLOCKED_EMAIL_SET.has(normalized)) {
        return "This email address can't be used to sign up for myServiceTas. Please use a different email address.";
    }

    const domain = normalized.slice(atIndex + 1);
    const domainBlocked = NORMALIZED_DOMAINS.some(
        (blocked) => domain === blocked || domain.endsWith(`.${blocked}`)
    );
    if (domainBlocked) {
        return "Email addresses from this domain can't be used to sign up for myServiceTas. Please use a different email address.";
    }

    return null;
}
