"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import { InteractionStatus } from "@azure/msal-browser";
import {
    accountFeatureAvailable,
    webviewFeatureAvailable,
    impersonationFeatureAvailable,
    logoutRequest,
} from "@/config/auth-config";
import styles from "./Navbar.module.css";

export default function Navbar() {
    const { instance, inProgress } = useMsal();
    const isAuthenticated = useIsAuthenticated();
    const busy = inProgress !== InteractionStatus.None;

    // Resolved in an effect (not during render) so the static-export prerender
    // and the first client render agree; flips to true on localhost or when an
    // account API base is configured.
    const [accountAvailable, setAccountAvailable] = useState(false);
    const [webviewAvailable, setWebviewAvailable] = useState(false);
    const [impersonationAvailable, setImpersonationAvailable] = useState(false);
    useEffect(() => {
        setAccountAvailable(accountFeatureAvailable());
        setWebviewAvailable(webviewFeatureAvailable());
        setImpersonationAvailable(impersonationFeatureAvailable());
    }, []);

    const handleSignOut = () => instance.logoutRedirect(logoutRequest);

    return (
        <nav className={styles.navbar}>
            <Link href="/" className={styles.logo} aria-label="Service Tasmania home">
                <Image
                    src="/logos/tasmania-govt-green.svg"
                    alt="Tasmanian Government"
                    width={54}
                    height={50}
                    className={styles.logoEmblem}
                    priority
                />
                <span className={styles.logoDivider} aria-hidden="true" />
                <Image
                    src="/logos/service-tasmania-green.svg"
                    alt="Service Tasmania"
                    width={118}
                    height={48}
                    className={styles.logoWordmark}
                    priority
                />
            </Link>
            <div className={styles.links}>
                {!isAuthenticated && (
                    <div className={styles.help}>
                        <span className={styles.helpText}>Need help? </span>
                        <a
                            href="https://portal.my.service.tas.gov.au/contactus/"
                            className={styles.contactLink}
                        >
                            Contact us
                        </a>
                    </div>
                )}
                {isAuthenticated && (
                    <>
                        <Link href="/security" className={styles.link}>
                            Security
                        </Link>
                        {accountAvailable && (
                            <Link href="/account" className={styles.link}>
                                My Account
                            </Link>
                        )}
                        {webviewAvailable && (
                            <Link href="/webview" className={styles.link}>
                                Webview SSO
                            </Link>
                        )}
                        <Link href="/handoff" className={styles.link}>
                            System-browser SSO
                        </Link>
                        {impersonationAvailable && (
                            <Link href="/impersonate" className={styles.link}>
                                Impersonation
                            </Link>
                        )}
                        <button className={styles.signOutButton} onClick={handleSignOut} disabled={busy}>
                            Sign Out
                        </button>
                    </>
                )}
            </div>
        </nav>
    );
}
