export const PASSWORD_GUIDE_ERROR = "Your password does not meet the requirements of the password guide";
export const CONFIRM_PASSWORD_GUIDE_ERROR =
    "Your password confirmation does not meet the requirements of the password guide";

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 20;
const STANDARD_SYMBOLS = "!@#$%^&*()-_=+[]{};:'\",.<>/?\\|`~";
const ESCAPED_STANDARD_SYMBOLS = STANDARD_SYMBOLS.replace(/[\\\]^]/g, "\\$&");
const ALLOWED_PASSWORD_CHARS = new RegExp(`^[A-Za-z0-9${ESCAPED_STANDARD_SYMBOLS}]+$`);

export function isPasswordValid(password: string): boolean {
    if (password.length === 0) return false;
    if (/\s/.test(password)) return false;
    if (!ALLOWED_PASSWORD_CHARS.test(password)) return false;
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) return false;

    const categories = [/[a-z]/, /[A-Z]/, /[0-9]/, new RegExp(`[${ESCAPED_STANDARD_SYMBOLS}]`)];
    const matched = categories.filter((regex) => regex.test(password)).length;
    return matched >= 3;
}

export function describePasswordError(subError: string | undefined): string {
    switch (subError) {
        case "password_too_weak":
            return "Your password is too weak. Use at least 3 of: lowercase, uppercase, numbers, symbols.";
        case "password_too_short":
            return "Your password is too short. It must be at least 8 characters.";
        case "password_too_long":
            return "Your password is too long. Please choose a shorter one.";
        case "password_recently_used":
            return "You can't reuse a recent password. Please choose a different one.";
        case "password_banned":
            return "That password is too common or contains a banned word. Please choose something less guessable.";
        case "password_is_invalid":
            return "Your password contains disallowed characters. Please choose a different one.";
        default:
            return "Invalid password.";
    }
}