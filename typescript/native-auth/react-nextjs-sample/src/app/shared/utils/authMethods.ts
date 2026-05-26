import type { AuthenticationMethod } from "@azure/msal-browser/custom-auth";

export function pickPhoneMethod(methods: AuthenticationMethod[]): AuthenticationMethod | undefined {
    const phone = methods.find((method) => {
        const channel = method.challenge_channel?.toLowerCase();
        return channel === "sms" || channel === "phone";
    });

    return phone ?? methods[0];
}