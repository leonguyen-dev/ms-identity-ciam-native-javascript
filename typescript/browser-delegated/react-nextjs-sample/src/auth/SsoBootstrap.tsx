"use client";

import { useEffect, useRef } from "react";
import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import { EventType, InteractionStatus } from "@azure/msal-browser";
import { silentRequest } from "@/config/auth-config";

/**
 * Cross-app SSO bootstrap (Feature B / B1 — the `id_token_hint` replacement).
 *
 * Renders nothing. When this app is opened as an SSO target (a peer app linked
 * here with `?sso=1` and usually a `login_hint`), it tries to establish a
 * session WITHOUT any interactive prompt, using the shared Entra session on
 * ciamlogin.com:
 *
 *   1. `ssoSilent` — a hidden iframe to the authorize endpoint. Works only while
 *      the session cookie is readable in a third-party (iframe) context, so it
 *      typically FAILS on ciamlogin.com (third-party cookies are blocked on
 *      Safari/iOS always, and increasingly on Chrome). That failure is expected.
 *   2. Fallback: a top-level `prompt=none` redirect. A full-page navigation makes
 *      the session cookie first-party, so Entra resolves the existing session and
 *      returns a token with no UI. If there is genuinely no session it returns
 *      `login_required` and the user simply sees the normal Log in button.
 *
 * Loop guard: msalConfig has `navigateToLoginRequestUrl: true`, so after a failed
 * prompt=none redirect MSAL returns to the ORIGINAL url — which still carries
 * `?sso=1` — which would re-trigger this bootstrap forever. A sessionStorage
 * marker (which survives that navigation, unlike a ref) ensures we attempt at
 * most once per SSO entry: on the post-failure return we detect the marker, stop,
 * and strip the SSO query so the page settles on the signed-out view. A fresh
 * click on an SSO link starts a clean attempt.
 */
const SSO_ATTEMPT_KEY = "sso-bootstrap-attempted";

export function SsoBootstrap() {
    const { instance, inProgress } = useMsal();
    const isAuthenticated = useIsAuthenticated();
    const handled = useRef(false);

    // Surface the REAL reason a silent attempt failed. MsalProvider owns
    // handleRedirectPromise, so the prompt=none failure comes back as an event,
    // not a rejected promise we can await — the AADSTS code in the message is the
    // actual diagnosis (e.g. AADSTS50058 = no session, AADSTS65001 = consent).
    useEffect(() => {
        const callbackId = instance.addEventCallback((event) => {
            if (
                event.eventType === EventType.SSO_SILENT_FAILURE ||
                event.eventType === EventType.LOGIN_FAILURE ||
                event.eventType === EventType.ACQUIRE_TOKEN_FAILURE
            ) {
                console.warn("[SSO] silent attempt failed:", event.eventType, event.error);
            }
        });
        return () => {
            if (callbackId) instance.removeEventCallback(callbackId);
        };
    }, [instance]);

    useEffect(() => {
        // Wait until MSAL has finished handling any redirect response.
        if (inProgress !== InteractionStatus.None) return;
        // Already signed in (cache hit, or the prompt=none redirect just
        // succeeded): clear the marker so a later sign-out can retry SSO.
        if (isAuthenticated) {
            sessionStorage.removeItem(SSO_ATTEMPT_KEY);
            return;
        }
        if (handled.current) return;

        const params = new URLSearchParams(window.location.search);
        const wantSso = params.has("sso") || params.has("login_hint");
        if (!wantSso) return;

        handled.current = true;

        // Post-failure return: we already tried this SSO entry and came back still
        // unauthenticated (login_required = no session). Stop — don't loop. Clear
        // the marker and strip the SSO query so the page rests on the signed-out
        // view; the user can sign in normally or click an SSO link again.
        if (sessionStorage.getItem(SSO_ATTEMPT_KEY)) {
            sessionStorage.removeItem(SSO_ATTEMPT_KEY);
            const url = new URL(window.location.href);
            url.searchParams.delete("sso");
            url.searchParams.delete("login_hint");
            window.history.replaceState({}, "", url.toString());
            return;
        }

        // First attempt for this SSO entry.
        sessionStorage.setItem(SSO_ATTEMPT_KEY, "1");
        const loginHint = params.get("login_hint") ?? undefined;

        instance
            .ssoSilent({ ...silentRequest, loginHint })
            .then((result) => {
                // AuthenticatedTemplate re-renders off the LOGIN/ACQUIRE events
                // AuthProvider already listens for; just make this the active one.
                instance.setActiveAccount(result.account);
                sessionStorage.removeItem(SSO_ATTEMPT_KEY);
            })
            .catch(() => {
                // Any silent failure (third-party-cookie block, or no hint/account
                // to seed the iframe) → top-level prompt=none redirect, which reads
                // the session cookie first-party. The failure detail is logged by
                // the event callback above.
                instance.loginRedirect({ ...silentRequest, prompt: "none", loginHint });
            });
    }, [instance, inProgress, isAuthenticated]);

    return null;
}
