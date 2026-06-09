"use client";

import { ReactNode, useEffect, useState } from "react";
import {
    AuthenticationResult,
    EventType,
    PublicClientApplication,
} from "@azure/msal-browser";
import { MsalProvider } from "@azure/msal-react";
import { msalConfig } from "@/config/auth-config";

/**
 * A single PublicClientApplication instance is created lazily and reused across
 * renders / fast-refresh. MSAL v3+ must be initialized() before use, and
 * MsalProvider internally calls handleRedirectPromise(), so all we do here is
 * initialize, set the active account, and keep it in sync on LOGIN_SUCCESS.
 */
let pca: PublicClientApplication | null = null;

function getPca(): PublicClientApplication {
    if (!pca) {
        pca = new PublicClientApplication(msalConfig);
    }
    return pca;
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [instance, setInstance] = useState<PublicClientApplication | null>(null);

    useEffect(() => {
        const client = getPca();
        let cancelled = false;

        client.initialize().then(() => {
            if (cancelled) return;

            // Restore the active account on reload (sessionStorage cache).
            const accounts = client.getAllAccounts();
            if (accounts.length > 0 && !client.getActiveAccount()) {
                client.setActiveAccount(accounts[0]);
            }

            // Keep the active account current after a redirect sign-in completes.
            client.addEventCallback((event) => {
                if (
                    (event.eventType === EventType.LOGIN_SUCCESS ||
                        event.eventType === EventType.ACQUIRE_TOKEN_SUCCESS) &&
                    event.payload
                ) {
                    const result = event.payload as AuthenticationResult;
                    if (result.account) {
                        client.setActiveAccount(result.account);
                    }
                }
            });

            setInstance(client);
        });

        return () => {
            cancelled = true;
        };
    }, []);

    // Render nothing until MSAL is initialized so child components never call
    // into an uninitialized instance.
    if (!instance) {
        return null;
    }

    return <MsalProvider instance={instance}>{children}</MsalProvider>;
}
