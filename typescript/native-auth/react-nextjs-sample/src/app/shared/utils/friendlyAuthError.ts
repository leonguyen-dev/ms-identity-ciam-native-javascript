// Maps common AADSTS error codes returned by Entra External ID / CIAM to short,
// user-friendly messages. The raw server text contains Trace ID / Correlation ID /
// Timestamp tails that confuse end users and should never be displayed verbatim.

const AADSTS_MAP: Record<string, string> = {
    AADSTS552001: "Your session has timed out. Please start again.",
    AADSTS50126: "The email or password you entered is incorrect.",
    AADSTS50034: "We couldn't find an account with that email address.",
    AADSTS50053: "Your account is temporarily locked due to too many sign-in attempts. Please try again later.",
    AADSTS50058: "Your session has expired. Please sign in again.",
    AADSTS50140: "Sign-in was interrupted. Please try again.",
    AADSTS500121: "Multi-factor authentication failed. Please try again.",
    AADSTS7000218: "Authentication request was invalid. Please try again.",
    AADSTS9002313: "The verification code is invalid or has expired.",
    AADSTS501241: "Some required details are missing. Please complete all fields.",
};

const SCRUB_TAIL = /\s*Trace ID:[\s\S]*$/;

type ErrorLike = {
    errorData?: { errorDescription?: string };
    errorDescription?: string;
};

function getDescription(err: unknown): string {
    const anyErr = err as ErrorLike | undefined;
    return anyErr?.errorData?.errorDescription ?? anyErr?.errorDescription ?? "";
}

export function friendlyAuthError(err: unknown, fallback: string): string {
    const desc = getDescription(err);
    if (!desc) return fallback;

    const code = desc.match(/AADSTS\d+/)?.[0];
    if (code && AADSTS_MAP[code]) return AADSTS_MAP[code];

    // Strip the Trace ID / Correlation ID / Timestamp tail. If anything readable
    // remains and it isn't another raw AADSTS line, surface it; otherwise fall back.
    const scrubbed = desc.replace(SCRUB_TAIL, "").trim();
    if (!scrubbed || /^AADSTS\d+/.test(scrubbed)) return fallback;
    return scrubbed;
}

// Detects the "continuation_token has expired" case (AADSTS552001). When this
// fires, the server-side flow state is gone, so the page must reset its UI step
export function isContinuationTokenExpired(err: unknown): boolean {
    return /AADSTS552001/.test(getDescription(err));
}
