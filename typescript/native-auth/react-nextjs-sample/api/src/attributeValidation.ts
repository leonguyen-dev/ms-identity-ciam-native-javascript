/**
 * Server-side sign-up attribute validation — the authoritative business-rule check.
 *
 * Native authentication has no OnAttributeCollectionStart/Submit custom-extension hook
 * (those events fire only in browser-delegated user flows), so there is no Entra-side
 * place to run custom attribute logic during a native sign-up. Instead the React client
 * POSTs the collected attributes to /api/validate-attributes (handled by authProxy.ts)
 * immediately before SignUpAttributesRequiredState.submitAttributes(), and only proceeds
 * if this passes.
 *
 * The DetailsStep component runs the same checks client-side for instant feedback; this
 * module is where the rules actually live. The local-dev proxy (cors.js) mirrors this
 * logic so sign-up works under `npm run dev` — KEEP THE TWO IN SYNC.
 */

export interface AttributeInput {
    givenName?: unknown;
    surname?: unknown;
    dateOfBirth?: unknown;
    termsAccepted?: unknown;
}

export interface ValidationResult {
    valid: boolean;
    /** Field-keyed messages, e.g. { dateOfBirth: "You must be at least 16 years old." } */
    errors: Record<string, string>;
    /** First error, surfaced as the page-level message by the client. */
    message?: string;
}

const MIN_AGE = 16;
const MAX_AGE = 120;
const NAME_MAX = 64;
// A real name must contain at least one letter (any script).
const HAS_LETTER = /\p{L}/u;

// Reject angle brackets and any control character (code point < 0x20) as a basic
// injection guard. Written as a char-code scan to avoid control-char escapes in source.
function hasForbiddenChar(value: string): boolean {
    if (value.includes("<") || value.includes(">")) {
        return true;
    }
    for (const ch of value) {
        if (ch.charCodeAt(0) < 0x20) {
            return true;
        }
    }
    return false;
}

function validateName(value: unknown, field: string, label: string, errors: Record<string, string>): void {
    const v = typeof value === "string" ? value.trim() : "";
    if (v.length === 0) {
        errors[field] = `Please provide your ${label}.`;
        return;
    }
    if (v.length > NAME_MAX) {
        errors[field] = `Your ${label} must be ${NAME_MAX} characters or fewer.`;
        return;
    }
    if (hasForbiddenChar(v) || !HAS_LETTER.test(v)) {
        errors[field] = `Please enter a valid ${label}.`;
    }
}

function ageOn(dob: Date, now: Date): number {
    let age = now.getUTCFullYear() - dob.getUTCFullYear();
    const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
    if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
        age--;
    }
    return age;
}

function validateDateOfBirth(value: unknown, errors: Record<string, string>): void {
    if (typeof value !== "string" || value.trim().length === 0) {
        errors.dateOfBirth = "Please provide your date of birth.";
        return;
    }

    // Expect an ISO calendar date (YYYY-MM-DD), as produced by <input type="date">.
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) {
        errors.dateOfBirth = "Please enter a valid date of birth.";
        return;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const dob = new Date(Date.UTC(year, month - 1, day));

    // Reject impossible dates that the Date constructor silently rolls over (e.g. 31 Feb).
    if (dob.getUTCFullYear() !== year || dob.getUTCMonth() !== month - 1 || dob.getUTCDate() !== day) {
        errors.dateOfBirth = "Please enter a valid date of birth.";
        return;
    }

    const now = new Date();
    if (dob.getTime() > now.getTime()) {
        errors.dateOfBirth = "Your date of birth can't be in the future.";
        return;
    }

    const age = ageOn(dob, now);
    if (age < MIN_AGE) {
        errors.dateOfBirth = `You must be at least ${MIN_AGE} years old to create an account.`;
        return;
    }
    if (age > MAX_AGE) {
        errors.dateOfBirth = "Please enter a valid date of birth.";
    }
}

export function validateSignUpAttributes(input: AttributeInput | null | undefined): ValidationResult {
    const errors: Record<string, string> = {};
    const data = input ?? {};

    validateName(data.givenName, "givenName", "given name", errors);
    validateName(data.surname, "surname", "family name", errors);
    validateDateOfBirth(data.dateOfBirth, errors);

    // Boolean attribute — must be explicitly true, not a truthy string.
    if (data.termsAccepted !== true) {
        errors.termsAccepted = "You must agree to the terms and conditions.";
    }

    const valid = Object.keys(errors).length === 0;
    return {
        valid,
        errors,
        message: valid ? undefined : Object.values(errors)[0],
    };
}
