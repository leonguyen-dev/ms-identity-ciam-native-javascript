"use client";

import { useCallback, useEffect, useState } from "react";
import {
    AuthenticatedTemplate,
    UnauthenticatedTemplate,
    useMsal,
} from "@azure/msal-react";
import {
    AuthError,
    InteractionRequiredAuthError,
    InteractionStatus,
} from "@azure/msal-browser";
import { loginRequest, ngcmfaClaims, passkeyRpId } from "@/config/auth-config";
import {
    PasskeyInfo,
    createPasskeyCredential,
    deletePasskey,
    fetchCreationOptions,
    fetchPasskeys,
    registerPasskey,
} from "@/services/passkey-service";

const styles = {
    page: {
        backgroundColor: "#f5f5f5",
        minHeight: "calc(100vh - 3.75rem)",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        color: "#292929",
    },
    hero: { backgroundColor: "#098851", padding: "3.75rem 0" },
    heroInner: { maxWidth: "80rem", margin: "0 auto", padding: "0 2.5rem" },
    heroTitle: { color: "#ffffff", fontSize: "2rem", fontWeight: 700, margin: 0 },
    cardWrap: { maxWidth: "80rem", margin: "-2.5rem auto 2.5rem", padding: "0 2.5rem" },
    card: { backgroundColor: "#ffffff", padding: "2.5rem 4rem" },
    content: { maxWidth: "44rem", margin: "0 auto" },
    heading: { fontSize: "1.875rem", fontWeight: 700, margin: "0 0 0.75rem 0" },
    lead: { fontSize: "1rem", margin: "0 0 1.5rem 0", lineHeight: 1.6 },
    sectionTitle: { fontSize: "1.125rem", fontWeight: 800, margin: "2rem 0 0.75rem 0" },
    banner: {
        padding: "0.875rem 1rem",
        margin: "0 0 1.5rem 0",
        fontSize: "0.9375rem",
        lineHeight: 1.5,
    },
    bannerInfo: { backgroundColor: "#eef6f2", border: "0.0625rem solid #267151" },
    bannerSuccess: { backgroundColor: "#eef6f2", border: "0.0625rem solid #098851", fontWeight: 700 },
    bannerError: { backgroundColor: "#fdf2f2", border: "0.0625rem solid #b91c1c" },
    bannerWarning: { backgroundColor: "#fffbeb", border: "0.0625rem solid #b45309" },
    list: { listStyle: "none", padding: 0, margin: 0 },
    listItem: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: "1rem",
        padding: "1rem 1.25rem",
        border: "0.0625rem solid #d1d5db",
        marginBottom: "0.75rem",
    },
    passkeyName: { fontWeight: 800, margin: "0 0 0.25rem 0", wordBreak: "break-all" as const },
    passkeyMeta: { margin: 0, color: "#6b7280", fontSize: "0.875rem", lineHeight: 1.6 },
    typeBadge: {
        display: "inline-block",
        padding: "0.125rem 0.5rem",
        marginLeft: "0.5rem",
        backgroundColor: "#eef6f2",
        color: "#267151",
        fontSize: "0.75rem",
        fontWeight: 800,
        verticalAlign: "middle" as const,
    },
    primaryButton: {
        display: "inline-block",
        padding: "0.75rem 3rem",
        backgroundColor: "#267151",
        color: "#ffffff",
        border: "none",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "1rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    secondaryButton: {
        padding: "0.5rem 1.25rem",
        backgroundColor: "#ffffff",
        color: "#b91c1c",
        border: "0.0625rem solid #b91c1c",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "0.875rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    confirmRow: { display: "flex", gap: "0.75rem", alignItems: "center" },
    nameInput: {
        display: "block",
        width: "100%",
        maxWidth: "24rem",
        padding: "0.625rem 0.75rem",
        margin: "0 0 1rem 0",
        border: "0.0625rem solid #6b7280",
        borderRadius: "0",
        fontSize: "1rem",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    inputLabel: { display: "block", fontWeight: 700, margin: "0 0 0.375rem 0" },
    empty: { padding: "1.5rem", border: "0.0625rem dashed #d1d5db", color: "#6b7280", margin: "0 0 1rem 0" },
} as const;

type Banner = { kind: "info" | "success" | "error" | "warning"; text: string } | null;

const PENDING_ACTION_KEY = "passkeyPendingAction";
const GRAPH_PROPAGATION_DELAY_MS = 2000;

type PendingAction =
    | { action: "add"; name: string }
    | { action: "delete"; passkey: { id: string; name: string } };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bannerStyle(kind: NonNullable<Banner>["kind"]) {
    const variant =
        kind === "success"
            ? styles.bannerSuccess
            : kind === "error"
              ? styles.bannerError
              : kind === "warning"
                ? styles.bannerWarning
                : styles.bannerInfo;
    return { ...styles.banner, ...variant };
}

function formatDate(value: string | null): string {
    if (!value) return "—";
    return new Date(value).toLocaleString("en-AU", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function PasskeyManager() {
    const { instance, inProgress } = useMsal();

    const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [banner, setBanner] = useState<Banner>(null);
    const [pendingDelete, setPendingDelete] = useState<PasskeyInfo | null>(null);
    const [newName, setNewName] = useState("");
    const [originOk, setOriginOk] = useState(true);

    // Passkey REGISTRATION must run on the relying-party domain (rp.id) or a
    // subdomain of it; anywhere else navigator.credentials.create() fails with
    // SecurityError. Sign-in with an existing passkey is unaffected (it happens
    // on the Entra-hosted pages).
    useEffect(() => {
        const host = window.location.hostname;
        const onRpDomain = host === passkeyRpId || host.endsWith(`.${passkeyRpId}`);
        const hasWebAuthn = typeof window.PublicKeyCredential !== "undefined";
        setOriginOk(onRpDomain && hasWebAuthn);
    }, []);

    const getAccount = useCallback(
        () => instance.getActiveAccount() ?? instance.getAllAccounts()[0],
        [instance]
    );

    /** Cached token — good enough for the read-only list call. */
    const getListToken = useCallback(async () => {
        const result = await instance.acquireTokenSilent({
            scopes: loginRequest.scopes,
            account: getAccount(),
        });
        return result.idToken;
    }, [instance, getAccount]);

    /**
     * Token carrying the ngcmfa claims challenge for add/delete. If the user's
     * MFA isn't fresh enough, Entra refuses the silent request; we stash the
     * attempted action and bounce through an interactive redirect so the user
     * can complete MFA, then resume on return (see the pending-action effect).
     */
    const getFreshMfaToken = useCallback(
        async (pendingAction: PendingAction): Promise<string | null> => {
            const request = {
                scopes: loginRequest.scopes,
                claims: ngcmfaClaims,
                account: getAccount(),
            };
            try {
                const result = await instance.acquireTokenSilent(request);
                return result.idToken;
            } catch (error) {
                const needsInteraction =
                    error instanceof InteractionRequiredAuthError ||
                    (error instanceof AuthError && error.errorCode === "invalid_grant");
                if (!needsInteraction) throw error;

                sessionStorage.setItem(PENDING_ACTION_KEY, JSON.stringify(pendingAction));
                setBanner({
                    kind: "info",
                    text: "To keep your account secure, you need to verify your identity (multi-factor authentication). Redirecting…",
                });
                await instance.acquireTokenRedirect(request);
                return null; // navigation takes over
            }
        },
        [instance, getAccount]
    );

    const loadPasskeys = useCallback(
        async (settled?: (list: PasskeyInfo[]) => boolean) => {
            setLoading(true);
            try {
                const token = await getListToken();
                let list = await fetchPasskeys(token);
                // Graph propagation after add/delete can lag a little — retry
                // until the expected change shows up.
                for (let attempt = 1; settled && !settled(list) && attempt <= 4; attempt++) {
                    await sleep(700 * attempt);
                    list = await fetchPasskeys(token);
                }
                setPasskeys(list);
                return list;
            } catch (error) {
                setBanner({
                    kind: "error",
                    text: `Could not load your passkeys: ${(error as Error).message}`,
                });
                return null;
            } finally {
                setLoading(false);
            }
        },
        [getListToken]
    );

    const performAdd = useCallback(
        async (name: string) => {
            setBusy(true);
            setBanner(null);
            const previousCount = passkeys.length;
            try {
                const token = await getFreshMfaToken({ action: "add", name });
                if (!token) return; // redirecting for MFA

                setBanner({
                    kind: "info",
                    text: "Follow your browser's prompts to create the passkey (Windows Hello, security key, or scan the QR code with your phone).",
                });
                const options = await fetchCreationOptions(token);
                const credential = await createPasskeyCredential(options);

                const displayName =
                    name.trim() ||
                    `myServiceTas passkey ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
                await registerPasskey(token, credential, displayName);

                setBanner({ kind: "success", text: `Passkey "${displayName}" added.` });
                setNewName("");
                await sleep(GRAPH_PROPAGATION_DELAY_MS);
                await loadPasskeys((list) => list.length > previousCount);
            } catch (error) {
                const err = error as Error;
                if (err.name === "NotAllowedError") {
                    setBanner({
                        kind: "error",
                        text: "Passkey creation was cancelled, timed out, or a passkey is already registered on this device/key.",
                    });
                } else if (err.name === "SecurityError") {
                    setBanner({
                        kind: "error",
                        text: `This page's domain doesn't match the passkey relying party (${passkeyRpId}). Serve the app from https://auth.${passkeyRpId}:3000 — see the README's Passkeys section.`,
                    });
                } else {
                    setBanner({ kind: "error", text: `Could not add the passkey: ${err.message}` });
                }
            } finally {
                setBusy(false);
            }
        },
        [getFreshMfaToken, loadPasskeys, passkeys.length]
    );

    const performDelete = useCallback(
        async (passkey: { id: string; name: string }) => {
            setBusy(true);
            setBanner(null);
            try {
                const token = await getFreshMfaToken({ action: "delete", passkey });
                if (!token) return; // redirecting for MFA

                await deletePasskey(token, passkey.id);
                setBanner({ kind: "success", text: `Passkey "${passkey.name}" deleted.` });
                await loadPasskeys((list) => !list.some((p) => p.id === passkey.id));
            } catch (error) {
                setBanner({
                    kind: "error",
                    text: `Could not delete the passkey: ${(error as Error).message}`,
                });
            } finally {
                setPendingDelete(null);
                setBusy(false);
            }
        },
        [getFreshMfaToken, loadPasskeys]
    );

    // Initial load + resume an action interrupted by the MFA redirect.
    useEffect(() => {
        if (inProgress !== InteractionStatus.None) return;

        const stored = sessionStorage.getItem(PENDING_ACTION_KEY);
        if (stored) {
            sessionStorage.removeItem(PENDING_ACTION_KEY);
            try {
                const pending = JSON.parse(stored) as PendingAction;
                if (pending.action === "add") {
                    void loadPasskeys().then(() => performAdd(pending.name));
                    return;
                }
                if (pending.action === "delete") {
                    // Re-show the confirmation rather than deleting unprompted.
                    void loadPasskeys().then((list) => {
                        const match = list?.find((p) => p.id === pending.passkey.id);
                        if (match) setPendingDelete(match);
                    });
                    return;
                }
            } catch {
                // fall through to a plain load
            }
        }
        void loadPasskeys();
        // Run once per completed interaction cycle, not on every callback identity change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inProgress]);

    return (
        <>
            {!originOk && (
                <p style={bannerStyle("warning")}>
                    Passkey <strong>registration</strong> only works when this app is served from{" "}
                    <strong>{passkeyRpId}</strong> or a subdomain of it (locally:{" "}
                    <code>https://auth.{passkeyRpId}:3000</code> — see the README&apos;s Passkeys
                    section). Signing in with an already-registered passkey works from anywhere,
                    because that happens on the Entra-hosted pages.
                </p>
            )}
            {banner && <p style={bannerStyle(banner.kind)}>{banner.text}</p>}

            <h2 style={styles.sectionTitle}>Your passkeys</h2>
            {loading ? (
                <p style={styles.empty}>Loading your passkeys…</p>
            ) : passkeys.length === 0 ? (
                <p style={styles.empty}>
                    You don&apos;t have any passkeys yet. Add one below to sign in with your face,
                    fingerprint, PIN, or security key instead of a password.
                </p>
            ) : (
                <ul style={styles.list}>
                    {passkeys.map((passkey) => (
                        <li key={passkey.id} style={styles.listItem}>
                            <div>
                                <p style={styles.passkeyName}>
                                    {passkey.name}
                                    <span style={styles.typeBadge}>{passkey.passkeyType}</span>
                                </p>
                                <p style={styles.passkeyMeta}>
                                    {passkey.model}
                                    <br />
                                    Created: {formatDate(passkey.createdDateTime)} · Last used:{" "}
                                    {formatDate(passkey.lastUsedDateTime)}
                                </p>
                            </div>
                            {pendingDelete?.id === passkey.id ? (
                                <div style={styles.confirmRow}>
                                    <button
                                        style={{ ...styles.secondaryButton, backgroundColor: "#b91c1c", color: "#ffffff" }}
                                        onClick={() => performDelete(passkey)}
                                        disabled={busy}
                                    >
                                        Confirm delete
                                    </button>
                                    <button
                                        style={{ ...styles.secondaryButton, color: "#292929", borderColor: "#6b7280" }}
                                        onClick={() => setPendingDelete(null)}
                                        disabled={busy}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            ) : (
                                <button
                                    style={styles.secondaryButton}
                                    onClick={() => setPendingDelete(passkey)}
                                    disabled={busy}
                                >
                                    Delete
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            <h2 style={styles.sectionTitle}>Add a passkey</h2>
            <p style={styles.lead}>
                You&apos;ll be asked to verify your identity first, then your browser will guide you
                through creating the passkey on this device, a security key, or your phone.
            </p>
            <label style={styles.inputLabel} htmlFor="passkey-name">
                Passkey name (optional)
            </label>
            <input
                id="passkey-name"
                style={styles.nameInput}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="e.g. Work laptop — Windows Hello"
                disabled={busy}
            />
            <button
                style={{ ...styles.primaryButton, opacity: busy || !originOk ? 0.6 : 1 }}
                onClick={() => performAdd(newName)}
                disabled={busy || !originOk}
            >
                {busy ? "Working…" : "Add a passkey"}
            </button>
        </>
    );
}

function SignedOutView() {
    const { instance, inProgress } = useMsal();
    const busy = inProgress !== InteractionStatus.None;

    return (
        <>
            <p style={styles.lead}>
                Sign in to view and manage the passkeys on your account. Passkeys let you sign in
                with your face, fingerprint, PIN, or a security key instead of a password.
            </p>
            <button
                style={styles.primaryButton}
                onClick={() => instance.loginRedirect(loginRequest)}
                disabled={busy}
            >
                Log in
            </button>
        </>
    );
}

export default function SecurityPage() {
    return (
        <main style={styles.page}>
            <div style={styles.hero}>
                <div style={styles.heroInner}>
                    <h1 style={styles.heroTitle}>Account security</h1>
                </div>
            </div>
            <div style={styles.cardWrap}>
                <div style={styles.card}>
                    <div style={styles.content}>
                        <h2 style={styles.heading}>Passkeys</h2>
                        <AuthenticatedTemplate>
                            <PasskeyManager />
                        </AuthenticatedTemplate>
                        <UnauthenticatedTemplate>
                            <SignedOutView />
                        </UnauthenticatedTemplate>
                    </div>
                </div>
            </div>
        </main>
    );
}
