"use client";

import { useEffect, useRef } from "react";
import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import { EventType, InteractionStatus } from "@azure/msal-browser";
import { loginRequest, silentRequest } from "@/config/auth-config";

/**
 * Cross-app SSO bootstrap (Feature B / B1 — the `id_token_hint` replacement).
 *
 * Renders nothing. On EVERY load, whenever this app opens unauthenticated it
 * tries to establish a session WITHOUT any interactive prompt, using the shared
 * Entra session on ciamlogin.com. This is no longer gated on `?sso=1`; that
 * query (and an optional `login_hint`) is still honoured to seed the attempt
 * when a peer app links here, but its absence no longer skips the silent path:
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
 * It also serves the Native app → system browser handoff (Feature B / B3). When
 * opened with `?handoff=1` (+ a `login_hint`) it does NOT attempt the silent
 * paths: a real native app holds its tokens in-app, not as a ciamlogin.com
 * browser cookie, so the system browser it launches is cold and silent SSO is
 * impossible — the documented platform gap ("cross-app SSO through system
 * browsers isn't supported with native authentication"). Instead it goes
 * straight to an INTERACTIVE sign-in seeded with the hint: the email is
 * pre-filled, so with a registered passkey it is one tap. That is the chosen B3
 * interim (plan B3.2 option b). Forcing interactive here (loginRequest carries
 * prompt:"login") faithfully models that there is no session to silently resume
 * — in this web sample the target tab would otherwise share the IdP cookie and
 * resolve silently via the B1 path, which a real native app never can.
 *
 * Loop guard: msalConfig has `navigateToLoginRequestUrl: true`, so after a failed
 * prompt=none redirect MSAL returns to the ORIGINAL url, which would re-trigger
 * this bootstrap forever. A sessionStorage marker (which survives that navigation,
 * unlike a ref) ensures we attempt at most once per page session: on the
 * post-failure return we detect the marker, stop, and strip any SSO query so the
 * page settles on the signed-out view. A fresh load (new tab / reload) clears the
 * marker and starts a clean attempt — so silent SSO is retried each time the app
 * is opened, but never loops within a single entry.
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
        const wantHandoff = params.has("handoff");
        // Silent SSO is attempted on every load — no longer gated on `?sso=1`.
        // We only get here when unauthenticated (the isAuthenticated branch above
        // returns first), so an unprompted attempt to resume the shared session is
        // always the right move. The handoff path stays explicitly opt-in.

        handled.current = true;

        // Post-failure / re-entry return: we already tried this entry and came
        // back still unauthenticated (login_required = no session on the SSO
        // path, or the user cancelled the handoff sign-in). Stop — don't loop.
        // Clear the marker and strip the SSO/handoff query so the page rests on
        // the signed-out view; the user can sign in normally or click a link again.
        if (sessionStorage.getItem(SSO_ATTEMPT_KEY)) {
            sessionStorage.removeItem(SSO_ATTEMPT_KEY);
            const url = new URL(window.location.href);
            url.searchParams.delete("sso");
            url.searchParams.delete("handoff");
            url.searchParams.delete("login_hint");
            window.history.replaceState({}, "", url.toString());
            return;
        }

        // First attempt for this entry.
        sessionStorage.setItem(SSO_ATTEMPT_KEY, "1");
        const loginHint = params.get("login_hint") ?? undefined;

        // Native app → system browser handoff (Feature B / B3). There is no
        // shared session to resolve silently (the platform gap), so skip the
        // silent paths entirely and do an INTERACTIVE sign-in seeded with the
        // hint — the one-tap interim (plan B3.2 option b). loginRequest carries
        // prompt:"login", which forces the hosted page even if this browser
        // happens to hold a session, faithfully modelling the cold system
        // browser a real native app launches. On return the isAuthenticated
        // branch above clears the marker.
        if (wantHandoff) {
            instance.loginRedirect({ ...loginRequest, loginHint });
            return;
        }

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
