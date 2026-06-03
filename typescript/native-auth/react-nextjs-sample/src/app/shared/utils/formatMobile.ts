export function normalizeMobile(mobile: string): string {
    return /^[1-9]/.test(mobile) ? `0${mobile}` : mobile;
}

export function toLocalNumber(mobile: string): string {
    return mobile.replace(/\D/g, "").replace(/^0+/, "");
}

export function toMobileDisplay(mobile: string): string {
    const compactMobile = mobile.trim().replace(/[^\d+]/g, "");
    const countryCodes = ["+61", "+64", "61", "64"];

    for (const countryCode of countryCodes) {
        if (compactMobile.startsWith(countryCode)) {
            return normalizeMobile(toLocalNumber(compactMobile.slice(countryCode.length)));
        }
    }

    return normalizeMobile(mobile.trim());
}
