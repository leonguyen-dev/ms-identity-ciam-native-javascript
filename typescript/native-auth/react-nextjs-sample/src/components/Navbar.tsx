"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuthClient } from "@/auth/AuthClientProvider";
import styles from "./Navbar.module.css";

export default function Navbar() {
    const router = useRouter();
    const app = useAuthClient();

    const handleLogout = async () => {
        if (!app) return;
        try {
            const account = app.getCurrentAccount();
            if (account.data) {
                await account.data.signOut();
                console.log("User signed out successfully.");
            } else {
                console.log("No user currently signed in.");
            }
            // Clear any local session/state if necessary (MSAL handles its own cache)
            router.push("/"); // Redirect to home page after logout
        } catch (error) {
            console.error("Logout failed:", error);
            // Optionally, show an error message to the user
        }
    };

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
                <Link href="/" className={styles.link}>
                    Sign In
                </Link>
                <Link href="/sign-up" className={styles.link}>
                    Sign Up
                </Link>
                <Link href="/reset-password" className={styles.link}>
                    Reset Password
                </Link>
                <button onClick={handleLogout} className={styles.link} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit', textDecoration: 'underline' }}>
                    Sign Out
                </button>
            </div>
        </nav>
    );
}
