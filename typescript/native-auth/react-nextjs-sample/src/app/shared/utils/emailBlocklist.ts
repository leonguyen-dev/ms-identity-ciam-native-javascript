/**
 * Client-side sign-up blocklist.
 *
 * This is a UX convenience only: it shows the user an error the moment they
 * submit their email, before we call signUp() (so no verification code is ever
 * sent to a blocked address). It is NOT a security boundary — the native-auth
 * API can be called directly, bypassing this check. The authoritative block is
 * enforced server-side by the OnOtpSend custom authentication extension
 * (otp-email-function), which native auth fires before any code is sent;
 * OnAttributeCollectionStart is a secondary guard for the browser-delegated flow
 * only (native auth never fires it). Keep all three lists in sync.
 *
 * Entries are matched case-insensitively. Surrounding whitespace is ignored.
 */

// Generic message shown when the SERVER blocklist (OnOtpSend) rejects an address
// that this client list didn't catch — see isOtpSendExtensionBlock in
// friendlyAuthError. The server failure doesn't tell us whether it was the exact
// email or the domain, so this message covers both.
export const SERVER_BLOCKED_SIGNUP_MESSAGE =
    "This email address, or email addresses from this domain, can't be used to sign up for myServiceTas. Please use a different email address.";

// Exact email addresses to block
const BLOCKED_EMAILS: string[] = [
    "someone@example.com",
];

// Domains to block. Matches the domain itself and any subdomain
const BLOCKED_DOMAINS: string[] = [
    "mailinator.com",
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
