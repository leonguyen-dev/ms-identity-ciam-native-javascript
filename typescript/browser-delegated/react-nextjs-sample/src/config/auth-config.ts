import {
    Configuration,
    LogLevel,
    RedirectRequest,
    EndSessionRequest,
} from "@azure/msal-browser";

/**
 * Browser-delegated (redirect) configuration for the Service Tasmania POC on
 * Microsoft Entra External ID.
 *
 * Unlike the native-auth sample (which renders every form in React and proxies
 * the native-auth REST API), this app hands the whole sign-up / sign-in / reset
 * experience to the Entra-hosted user-flow pages. MSAL only kicks off the
 * redirect and reads the resulting tokens — so there is NO CORS proxy here.
 *
 * Authority note: for External ID you do NOT put the user-flow name in the
 * authority (that was a B2C custom-policy convention). The authority is just the
 * tenant; the app is bound to its user flow in the Entra admin centre
 * (External Identities > User flows > <flow> > Applications).
 */

const TENANT_SUBDOMAIN = "myservicetasdevpoc";
const TENANT_ID = "a67366e7-9873-4a38-9bae-0a4a18952688";

/**
 * Resolve the redirect/post-logout URI at runtime so one build works in both
 * local dev and the deployed SWA. Both values must be registered as SPA
 * redirect URIs on the app registration (see entra-config/README.md).
 */
function resolveAppOrigin(): string {
    if (typeof window === "undefined") {
        // Build-time prerender only — never used for a live redirect.
        return "http://localhost:3000";
    }
    return window.location.origin;
}

export const msalConfig: Configuration = {
    auth: {
        // SPA app registration created for the browser-delegated POC.
        // Replace with the real client id (see entra-config/README.md, step 5).
        clientId: "5f0a52ca-f5db-4a6d-9b3a-3180d51fdd08",
        authority: `https://${TENANT_SUBDOMAIN}.ciamlogin.com/${TENANT_ID}`,
        knownAuthorities: [`${TENANT_SUBDOMAIN}.ciamlogin.com`],
        redirectUri: `${resolveAppOrigin()}/`,
        postLogoutRedirectUri: `${resolveAppOrigin()}/`,
        // Return the user to the page that started login after the redirect is
        // processed (here that is always "/", which renders the signed-in view).
        navigateToLoginRequestUrl: true,
    },
    cache: {
        // Match the native-auth sample: tokens live only for the browser tab.
        cacheLocation: "sessionStorage",
        storeAuthStateInCookie: false,
    },
    system: {
        loggerOptions: {
            // Only surface warnings and errors. MSAL logs cache reads
            // ("Returning ID token", "Returning access token") at Info on every
            // token read, which floods the console after sign-in. Bump to Verbose
            // temporarily when debugging the auth flow.
            logLevel: LogLevel.Warning,
            loggerCallback: (level: LogLevel, message: string, containsPii: boolean) => {
                if (containsPii) {
                    return;
                }
                switch (level) {
                    case LogLevel.Error:
                        console.error(message);
                        return;
                    case LogLevel.Warning:
                        console.warn(message);
                        return;
                    case LogLevel.Info:
                        console.info(message);
                        return;
                    case LogLevel.Verbose:
                        console.debug(message);
                        return;
                }
            },
        },
    },
};

/**
 * Scopes requested at sign-in. openid + profile yield the ID token; the custom
 * `phone_number` claim is injected by the OnTokenIssuanceStart extension via the
 * claims-mapping policy assigned to this app (see token-issuance-function).
 * offline_access requests a refresh token for silent renewal.
 */
export const loginRequest: RedirectRequest = {
    scopes: ["openid", "profile", "offline_access"],
    // Force fresh authentication instead of silently resuming an existing Entra
    // session. Without this, a stale/half-established ciamlogin.com session from a
    // prior incomplete attempt makes "Log in" loop at the /reprocess step (Entra
    // keeps trying to resume the broken session). prompt=login sidesteps the loop
    // by always re-authenticating. (Sign-up overrides this with prompt=create.)
    prompt: "login",
};

/**
 * Sign-up request. Entra External ID honours `prompt=create` to take the user
 * straight to the sign-up experience of the bound user flow, mirroring the B2C
 * "Sign up now" entry point on the combined page.
 */
export const signUpRequest: RedirectRequest = {
    ...loginRequest,
    prompt: "create",
};

export const logoutRequest: EndSessionRequest = {};
