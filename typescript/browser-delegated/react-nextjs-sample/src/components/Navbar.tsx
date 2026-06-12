"use client";

import Link from "next/link";
import Image from "next/image";
import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import { InteractionStatus } from "@azure/msal-browser";
import { loginRequest, signUpRequest, logoutRequest } from "@/config/auth-config";
import styles from "./Navbar.module.css";

export default function Navbar() {
    const { instance, inProgress } = useMsal();
    const isAuthenticated = useIsAuthenticated();
    const busy = inProgress !== InteractionStatus.None;

    const handleSignIn = () => instance.loginRedirect(loginRequest);
    const handleSignUp = () => instance.loginRedirect(signUpRequest);
    const handleSignOut = () => instance.logoutRedirect(logoutRequest);

    return (
        <nav className={styles.navbar}>
            <Link href="/" className={styles.logo} aria-label="Service Tasmania home">
                <Image
                    src="/logos/tasmania-govt-black.svg"
                    alt="Tasmanian Government"
                    width={54}
                    height={50}
                    className={styles.logoEmblem}
                    priority
                />
                <span className={styles.logoDivider} aria-hidden="true" />
                <Image
                    src="/logos/service-tasmania-black.svg"
                    alt="Service Tasmania"
                    width={118}
                    height={48}
                    className={styles.logoWordmark}
                    priority
                />
            </Link>
            <div className={styles.links}>
                {!isAuthenticated && (
                    <>
                        <button className={styles.link} onClick={handleSignIn} disabled={busy}>
                            Sign In
                        </button>
                        <button className={styles.link} onClick={handleSignUp} disabled={busy}>
                            Sign Up
                        </button>
                        <Link href="/reset-password" className={styles.link}>
                            Reset Password
                        </Link>
                    </>
                )}
                {isAuthenticated && (
                    <>
                        <Link href="/account" className={styles.link}>
                            My Account
                        </Link>
                        <button className={styles.link} onClick={handleSignOut} disabled={busy}>
                            Sign Out
                        </button>
                    </>
                )}
            </div>
        </nav>
    );
}
