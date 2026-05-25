"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import {
    CustomAuthPublicClientApplication,
    ICustomAuthPublicClientApplication,
} from "@azure/msal-browser/custom-auth";
import { customAuthConfig } from "../config/auth-config";

let appPromise: Promise<ICustomAuthPublicClientApplication> | null = null;

function getAuthClient(): Promise<ICustomAuthPublicClientApplication> {
    if (!appPromise) {
        appPromise = CustomAuthPublicClientApplication.create(customAuthConfig);
    }
    return appPromise;
}

const AuthClientContext = createContext<ICustomAuthPublicClientApplication | null>(null);

export function AuthClientProvider({ children }: { children: ReactNode }) {
    const [client, setClient] = useState<ICustomAuthPublicClientApplication | null>(null);

    useEffect(() => {
        let cancelled = false;
        getAuthClient().then((c) => {
            if (!cancelled) setClient(c);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    return <AuthClientContext.Provider value={client}>{children}</AuthClientContext.Provider>;
}

export function useAuthClient(): ICustomAuthPublicClientApplication | null {
    return useContext(AuthClientContext);
}
