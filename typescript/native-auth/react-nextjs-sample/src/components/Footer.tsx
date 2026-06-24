"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuthClient } from "@/auth/AuthClientProvider";
import styles from "./Footer.module.css";

function ServiceCentreIcon() {
    return (
        <svg className={styles.serviceCentreIcon} viewBox="0 0 56 64" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M21.166 19.262c1.266.497 2.533 1.003 3.826 1.494 3.089 1.175 6.586 1.641 9.873.974 6.406-1.302 6.91-6.512 12.528-5.194 5.618 1.319 5.24 9.128 3.72 14.413-1.518 5.284-4.185 6.31-4.8 10.672-.614 4.362.351 5.15-1.23 8.725-1.581 3.575-.85.914-3.686.257s-2.782-.66-5.268 3.834c-2.485 4.493-3.277 6.256-6.965 5.658-3.69-.598-4.48 2.02-6.528-1.252-2.049-3.273-1.99-2.423-6.027-7.314-1.385-1.679-3.108-3.472-3.879-5.558-.771-2.086.727-3.51 1.272-5.387a6.849 6.849 0 0 0-.905-5.653c-2.066-3.078-3.401-6.88-4.368-10.259-.343-1.199-.768-2.423-.923-3.667-.168-1.343.185-4.367 1.75-4.938 1.635-.596 4.09.592 5.62 1.055 2.047.623 4.02 1.37 5.99 2.14ZM46.587 8.861v.025c-.047.64.359.84.739 1.258.571.633.934 1.43 1.037 2.282.063.446.089.906.334 1.304.117.197.297.348.51.427.474.167.859-.12 1.188-.427.395-.371.698-.633 1.197-.84.573-.239.697-1.161.095-1.463-.253-.128-.835-.03-.83-.455.007-.485.82-.664.907-1.129.114-.61.051-1.202-.495-1.568-.284-.19-.613-.295-.922-.439-1.183-.553-1.213-1.981-1.992-2.895a2.232 2.232 0 0 0-.968-.663c-1.335-.455-1.568 1.41-2.437 1.922a.79.79 0 0 0-.244.174c-.21.275.224.396.408.42.423.065.808.284 1.084.615.358.428.426.918.39 1.452ZM6.03 4.198c.2.024.447.162.756.33.355.19.786.453.844.9.12.916-.587 1.782-.34 2.687.145.534.919.782.885 1.344a1.44 1.44 0 0 1-.235.64 4.773 4.773 0 0 1-1.306 1.443c-.317.224-1.425.948-1.648.277-.158-.473.123-.974.167-1.442.048-.504-.21-.91-.45-1.33-.256-.456.106-.987.078-1.47-.023-.37-.253-.48-.364-.795-.153-.427.162-.765.485-1.013.323-.247.434-.533.54-.919.145-.53.329-.686.588-.652Z" />
        </svg>
    );
}

function PhoneIcon() {
    return (
        <svg className={styles.phoneIcon} viewBox="0 0 36 40" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="m35.361 36.916-3.29 2.172c-2.119 1.459-11.146 3.099-23.427-11.779C-3.196 12.985.19 5.042 1.778 3.21L4.511.37A1.527 1.527 0 0 1 6.68.55l7.187 8.501.004.005a1.535 1.535 0 0 1-.183 2.176v.007l-3.185 2.297c-1.26 1.25-.162 3.217 1.127 5.118l6.129 7.236c2.85 2.752 4.413 4.023 5.777 3.114l2.649-2.954a1.535 1.535 0 0 1 2.17.18l7.191 8.502v.004a1.545 1.545 0 0 1-.186 2.181Z" />
        </svg>
    );
}

function ChatIcon() {
    return (
        <svg className={styles.chatIcon} viewBox="0 0 40 40" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M38 8h-4v18H8v4c0 1.1.9 2 2 2h22l8 8V10c0-1.1-.9-2-2-2Zm-8 12V2c0-1.1-.9-2-2-2H2C.9 0 0 .9 0 2v28l8-8h20c1.1 0 2-.9 2-2Z" />
        </svg>
    );
}

function InterpreterIcon() {
    return (
        <svg
            className={styles.interpreterIcon}
            viewBox="0 0 50 37"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            xmlnsXlink="http://www.w3.org/1999/xlink"
            aria-hidden="true"
        >
            <path fill="url(#interpreter-icon_a)" d="M0 0h50v37H0z" />
            <defs>
                <pattern id="interpreter-icon_a" patternContentUnits="objectBoundingBox" width="1" height="1">
                    <use xlinkHref="#interpreter-icon_b" transform="scale(.01 .01351)" />
                </pattern>
                <image
                    id="interpreter-icon_b"
                    width="100"
                    height="74"
                    xlinkHref="data:image/png;base64,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"
                />
            </defs>
        </svg>
    );
}

function FacebookIcon() {
    return (
        <svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M29.5 15c0 8.008-6.492 14.5-14.5 14.5S.5 23.008.5 15 6.992.5 15 .5 29.5 6.992 29.5 15Z" stroke="#fff" />
            <path d="M18.75 10h-1.68c-.68 0-.82.28-.82 1v1.52h2.5l-.26 2.5h-2.24v8.75H12.5V15H10v-2.5h2.5V9.62c0-2.21 1.17-3.37 3.79-3.37h2.46V10Z" fill="#fff" />
        </svg>
    );
}

function InstagramIcon() {
    return (
        <svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="15" cy="15" r="14.5" stroke="#fff" />
            <rect x="8" y="8" width="14" height="14" rx="4" stroke="#fff" strokeWidth="1.5" />
            <circle cx="15" cy="15" r="3.7" stroke="#fff" strokeWidth="1.5" />
            <circle cx="19.2" cy="10.8" r="1.1" fill="#fff" />
        </svg>
    );
}

export default function Footer() {
    const pathname = usePathname();
    const app = useAuthClient();
    const [isSignedIn, setIsSignedIn] = useState(false);

    useEffect(() => {
        if (!app) return;
        const checkAccount = () => setIsSignedIn(!!app.getCurrentAccount().data);

        checkAccount();
        // Sign-in completes on the home page without a navigation, so poll the
        // MSAL cache to pick up the change promptly. Also re-check on focus.
        const interval = setInterval(checkAccount, 800);
        window.addEventListener("focus", checkAccount);
        return () => {
            clearInterval(interval);
            window.removeEventListener("focus", checkAccount);
        };
    }, [app, pathname]);

    // Footer is only shown on the pre-sign-in pages (sign-in, sign-up, reset-password).
    if (isSignedIn) return null;

    return (
        <footer className={styles.footer}>
            <div className={styles.contact}>
                <div className={styles.inner}>
                    <h2 className={styles.heading}>Need to speak to us?</h2>

                    <div className={styles.cards}>
                        <div className={styles.card}>
                            <ServiceCentreIcon />
                            <div className={`${styles.cardBody} ${styles.cardBodyFlush}`}>
                                <a
                                    href="https://www.service.tas.gov.au/find-a-service-centre"
                                    className={styles.link}
                                >
                                    Find a Service Centre
                                </a>
                            </div>
                        </div>

                        <div className={styles.card}>
                            <PhoneIcon />
                            <div className={styles.cardBody}>
                                <span className={styles.cardLabel}>Call us: </span>
                                <a href="tel:1300135513" className={styles.link}>1300 13 55 13</a>
                                <br />
                                <span className={styles.cardLabel}>International </span>
                                <a href="tel:+61361699017" className={styles.link}>+61 3 6169 9017</a>
                            </div>
                        </div>

                        <div className={styles.card}>
                            <ChatIcon />
                            <div className={styles.cardBody}>
                                <span className={styles.cardLabel}>Ask us: </span>
                                <br />
                                <a
                                    href="https://portal.my.service.tas.gov.au/contactus/"
                                    className={styles.link}
                                >
                                    Submit an enquiry online
                                </a>
                            </div>
                        </div>
                    </div>

                    <p className={styles.note}>
                        <InterpreterIcon />
                        <span>
                            Need an interpreter? Call:{" "}
                            <a href="tel:131450" className={styles.link}>131 450</a>
                        </span>
                    </p>
                    <p className={styles.note}>
                        <span>
                            Service Centres open various hours –{" "}
                            <a
                                href="https://www.service.tas.gov.au/about/service-centres"
                                className={styles.link}
                            >
                                find yours
                            </a>
                            .
                        </span>
                    </p>

                    <p className={`${styles.note} ${styles.noteSocial}`}>
                        <span>You can also contact us on social media.</span>
                    </p>

                    <div className={styles.social}>
                        <a
                            href="https://www.facebook.com/ServiceTasmania"
                            className={styles.socialIcon}
                            aria-label="Service Tasmania on Facebook"
                        >
                            <FacebookIcon />
                        </a>
                        <a
                            href="https://www.instagram.com/servicetasmania"
                            target="_blank"
                            rel="noreferrer"
                            className={styles.socialIcon}
                            aria-label="Service Tasmania on Instagram"
                        >
                            <InstagramIcon />
                        </a>
                    </div>

                    <div className={styles.acknowledgement}>
                        We acknowledge and pay our respects to all Aboriginal people in Tasmania; their identity and culture.
                    </div>
                </div>
            </div>

            <div className={styles.bottomBar}>
                <div className={styles.bottomInner}>
                    <nav className={styles.legalLinks} aria-label="Legal">
                        <a href="https://www.service.tas.gov.au/privacy" className={styles.legalLink}>
                            Personal information protection
                        </a>
                        <a href="https://www.service.tas.gov.au/copyright" className={styles.legalLink}>
                            Copyright and disclaimer
                        </a>
                        <a href="https://www.service.tas.gov.au/terms" className={styles.legalLink}>
                            Terms and Conditions
                        </a>
                        <a href="https://www.service.tas.gov.au/accessibility" className={styles.legalLink}>
                            Accessibility
                        </a>
                    </nav>

                    <div className={styles.brand}>
                        <Image
                            src="/logos/tasmania-govt-black.svg"
                            alt="Tasmanian Government"
                            width={54}
                            height={50}
                            className={styles.brandEmblem}
                        />
                        <span className={styles.brandDivider} aria-hidden="true" />
                        <Image
                            src="/logos/service-tasmania-black.svg"
                            alt="Service Tasmania"
                            width={118}
                            height={48}
                            className={styles.brandWordmark}
                        />
                    </div>
                </div>
            </div>
        </footer>
    );
}
