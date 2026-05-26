export function normalizeMobile(mobile: string): string {
    return /^[1-9]/.test(mobile) ? `0${mobile}` : mobile;
}

export function toLocalNumber(mobile: string): string {
    return mobile.replace(/\D/g, "").replace(/^0+/, "");
}
