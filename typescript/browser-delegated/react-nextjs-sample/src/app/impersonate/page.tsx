"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    AuthenticatedTemplate,
    UnauthenticatedTemplate,
    useMsal,
} from "@azure/msal-react";
import { InteractionRequiredAuthError, InteractionStatus } from "@azure/msal-browser";
import { appLabel, impersonationFeatureAvailable, loginRequest, silentRequest } from "@/config/auth-config";
import {
    fetchActiveImpersonation,
    fetchImpersonationAudit,
    impersonationViewUrl,
    ImpersonationApiError,
    revokeImpersonation,
    startImpersonation,
    stopImpersonation,
    type ImpersonationAuditEntry,
    type ImpersonationSession,
} from "@/services/impersonation-service";

/**
 * Impersonation portal — RWVP (Feature B / B4).
 *
 * The hardest cross-app scenario and the one External ID has no native IdP
 * pattern for: there is no supported way to mint a token AS another customer. So
 * this portal does impersonation where the plan says it must live (B4.1) — at the
 * application/session layer. An RBAC-gated admin enters a customer's email + a
 * justification; the backend (local-proxy.mjs) verifies the admin is allow-listed,
 * confirms the customer exists, and mints a short-lived, read-only, HttpOnly *app*
 * session (never an Entra token) recording both the acting admin and the subject.
 * The portal then shows that customer's view in an embedded iframe, surfaces the
 * audit trail, and can revoke any live session (plan B4.2 controls).
 */

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
    wrap: { maxWidth: "80rem", margin: "-2.5rem auto 2.5rem", padding: "0 2.5rem" },
    card: { backgroundColor: "#ffffff", padding: "2rem 2.5rem", marginBottom: "1.5rem" },
    lead: { fontSize: "1rem", margin: "0 0 1.5rem 0", lineHeight: 1.6 },
    sectionTitle: { fontSize: "1.25rem", fontWeight: 800, margin: "0 0 1rem 0" },
    label: { display: "block", fontWeight: 700, margin: "0 0 0.35rem 0" },
    input: {
        width: "100%",
        boxSizing: "border-box" as const,
        padding: "0.65rem 0.8rem",
        border: "0.0625rem solid #b0b0b0",
        borderRadius: 0,
        fontSize: "1rem",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        marginBottom: "1rem",
    },
    status: (kind: "info" | "ok" | "error") => ({
        padding: "0.75rem 1rem",
        borderRadius: "0.25rem",
        marginBottom: "1.5rem",
        fontWeight: 700,
        backgroundColor: kind === "error" ? "#fdecea" : kind === "ok" ? "#e6f4ec" : "#eef2f7",
        color: kind === "error" ? "#b3261e" : kind === "ok" ? "#098851" : "#404040",
    }),
    banner: {
        backgroundColor: "#b3261e",
        color: "#ffffff",
        padding: "0.85rem 1.25rem",
        fontWeight: 700,
        lineHeight: 1.5,
        marginBottom: "1.25rem",
    },
    note: (kind: "info" | "warn") => ({
        padding: "1rem 1.25rem",
        borderLeft: `0.25rem solid ${kind === "warn" ? "#b45309" : "#098851"}`,
        backgroundColor: kind === "warn" ? "#fef6e7" : "#e6f4ec",
        marginBottom: "1.5rem",
        lineHeight: 1.6,
    }),
    primaryButton: {
        display: "inline-block",
        padding: "0.75rem 2.5rem",
        backgroundColor: "#267151",
        color: "#ffffff",
        border: "none",
        borderRadius: "0",
        cursor: "pointer",
        fontSize: "1rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    dangerButton: {
        padding: "0.5rem 1.25rem",
        backgroundColor: "#b3261e",
        color: "#ffffff",
        border: "none",
        borderRadius: 0,
        cursor: "pointer",
        fontSize: "0.9375rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    revokeButton: {
        padding: "0.3rem 0.8rem",
        backgroundColor: "#ffffff",
        color: "#b3261e",
        border: "0.0625rem solid #b3261e",
        borderRadius: 0,
        cursor: "pointer",
        fontSize: "0.8125rem",
        fontWeight: 800,
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
    },
    deviceFrame: {
        maxWidth: "26rem",
        border: "0.75rem solid #1e1e1e",
        borderRadius: "1.75rem",
        overflow: "hidden" as const,
        backgroundColor: "#000",
    },
    deviceBar: { color: "#fff", fontSize: "0.8125rem", textAlign: "center" as const, padding: "0.5rem", fontWeight: 700 },
    iframe: { display: "block", width: "100%", height: "24rem", border: "none", backgroundColor: "#fff" },
    detailGrid: { display: "grid", gridTemplateColumns: "10rem 1fr", gap: "0.4rem 1rem", margin: "1.25rem 0", fontSize: "0.9375rem" },
    detailKey: { fontWeight: 700, color: "#267151" },
    table: { width: "100%", borderCollapse: "collapse" as const, fontSize: "0.875rem" },
    th: { textAlign: "left" as const, padding: "0.5rem", borderBottom: "0.125rem solid #d1d5db", color: "#404040" },
    td: { padding: "0.5rem", borderBottom: "0.0625rem solid #e5e7eb", verticalAlign: "top" as const },
    code: { backgroundColor: "#f0f0f0", padding: "0.1rem 0.35rem", borderRadius: "0.2rem", fontFamily: "ui-monospace, 'Consolas', monospace", fontSize: "0.85em" },
} as const;

const fmtTime = (epoch: number) => new Date(epoch * 1000).toLocaleString();
const idLabel = (i: { email: string | null; oid: string | null }) => i.email ?? i.oid ?? "unknown";

function Hero() {
    return (
        <div style={styles.hero}>
            <div style={styles.heroInner}>
                <h1 style={styles.heroTitle}>{`${appLabel} — impersonation portal (RWVP)`}</h1>
            </div>
        </div>
    );
}

function ImpersonationPortal() {
    const { instance } = useMsal();

    const [available, setAvailable] = useState(true);
    const [isAdmin, setIsAdmin] = useState<boolean | null>(null); // null = unknown yet
    const [adminMessage, setAdminMessage] = useState<string | null>(null);
    const [session, setSession] = useState<ImpersonationSession | null>(null);
    const [auditLog, setAuditLog] = useState<ImpersonationAuditEntry[]>([]);
    const [activeSessions, setActiveSessions] = useState<ImpersonationSession[]>([]);

    const [subjectEmail, setSubjectEmail] = useState("");
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<{ kind: "info" | "ok" | "error"; text: string } | null>(null);
    const [viewKey, setViewKey] = useState(0); // bump to force the iframe to reload
    const loaded = useRef(false);

    // Acquire the admin's ID token for the RBAC-gated calls (start/revoke/audit).
    const getToken = useCallback(async () => {
        const account = instance.getActiveAccount() ?? instance.getAllAccounts()[0];
        if (!account) throw new ImpersonationApiError("No signed-in account.");
        const result = await instance.acquireTokenSilent({ ...silentRequest, account });
        return result.idToken;
    }, [instance]);

    const refreshAudit = useCallback(async () => {
        const token = await getToken();
        const audit = await fetchImpersonationAudit(token);
        setAuditLog([...audit.log].reverse()); // newest first
        setActiveSessions(audit.active);
    }, [getToken]);

    // On mount: read any in-progress impersonation (cookie) and probe admin rights
    // by trying to read the audit log (a 403 with not_admin = RBAC gate).
    useEffect(() => {
        setAvailable(impersonationFeatureAvailable());
    }, []);

    useEffect(() => {
        if (!available || loaded.current) return;
        loaded.current = true;
        (async () => {
            try {
                setSession(await fetchActiveImpersonation());
            } catch {
                /* whoami failure is non-fatal — leave session null */
            }
            try {
                await refreshAudit();
                setIsAdmin(true);
            } catch (err) {
                if (err instanceof ImpersonationApiError && err.code === "not_admin") {
                    setIsAdmin(false);
                    setAdminMessage(err.message);
                } else {
                    setIsAdmin(true); // reachability issue, not an authz denial
                    setStatus({
                        kind: "error",
                        text: err instanceof Error ? err.message : "Could not load the impersonation portal.",
                    });
                }
            }
        })();
    }, [available, refreshAudit]);

    const handleStart = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();
            setBusy(true);
            setStatus({ kind: "info", text: "Starting impersonation session…" });
            try {
                const token = await getToken();
                const started = await startImpersonation(token, subjectEmail.trim(), reason.trim());
                setSession(started);
                setViewKey((k) => k + 1);
                setStatus({ kind: "ok", text: `Impersonating ${idLabel(started.subject)} — read-only, ends ${fmtTime(started.expiresAt)}.` });
                setReason("");
                await refreshAudit();
            } catch (err) {
                if (err instanceof InteractionRequiredAuthError) {
                    setStatus({ kind: "error", text: "Your session needs a refresh — please sign in again." });
                } else {
                    setStatus({ kind: "error", text: err instanceof Error ? err.message : "Could not start impersonation." });
                }
            } finally {
                setBusy(false);
            }
        },
        [getToken, subjectEmail, reason, refreshAudit]
    );

    const handleStop = useCallback(async () => {
        setBusy(true);
        try {
            await stopImpersonation();
            setSession(null);
            setStatus({ kind: "info", text: "Impersonation session ended." });
            await refreshAudit().catch(() => {});
        } catch (err) {
            setStatus({ kind: "error", text: err instanceof Error ? err.message : "Could not stop impersonation." });
        } finally {
            setBusy(false);
        }
    }, [refreshAudit]);

    const handleRevoke = useCallback(
        async (sessionId: string) => {
            setBusy(true);
            try {
                const token = await getToken();
                await revokeImpersonation(token, sessionId);
                // If we revoked our own active session, clear it locally too.
                if (session?.sessionId === sessionId) setSession(null);
                setStatus({ kind: "info", text: "Session revoked." });
                await refreshAudit();
            } catch (err) {
                setStatus({ kind: "error", text: err instanceof Error ? err.message : "Could not revoke the session." });
            } finally {
                setBusy(false);
            }
        },
        [getToken, refreshAudit, session]
    );

    if (!available) {
        return (
            <main style={styles.page}>
                <Hero />
                <div style={styles.wrap}>
                    <div style={styles.card}>
                        <div style={styles.status("error")}>
                            The impersonation portal needs the local proxy (<code style={styles.code}>npm run proxy</code>) and
                            runs on <code style={styles.code}>localhost</code>. It is disabled on this host.
                        </div>
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main style={styles.page}>
            <Hero />
            <div style={styles.wrap}>
                <div style={styles.card}>
                    <p style={styles.lead}>
                        The RWVP impersonation portal lets an authorised support administrator view a customer&rsquo;s
                        account <strong>as the customer sees it</strong>, to diagnose an issue. External ID has{" "}
                        <strong>no supported way to mint a token as another customer</strong> (the B2C{" "}
                        <code style={styles.code}>id_token_hint</code> trick doesn&rsquo;t exist here), so this is done at
                        the <strong>application/session layer</strong>: an RBAC-gated action mints a short-lived,
                        read-only, <code style={styles.code}>HttpOnly</code> <em>app</em> session — never an Entra token —
                        recording both the acting admin and the subject (plan Feature B / B4).
                    </p>

                    <div style={styles.note("warn")}>
                        <p style={{ fontWeight: 800, margin: "0 0 0.5rem 0" }}>Security model (plan B4.2)</p>
                        <p style={{ margin: 0 }}>
                            RBAC allow-list · separation of duties (no self-impersonation; the session never elevates the
                            admin&rsquo;s own rights) · least privilege (read-only) · bounded {`${15}`}-minute duration ·
                            server-side <strong>revocation</strong> · append-only <strong>audit log</strong> with a required
                            justification. Full design + review in{" "}
                            <code style={styles.code}>impersonation-portal-design.md</code>.
                        </p>
                    </div>

                    {status && <div style={styles.status(status.kind)}>{status.text}</div>}

                    {isAdmin === false && (
                        <div style={styles.note("warn")}>
                            <p style={{ fontWeight: 800, margin: "0 0 0.5rem 0" }}>RBAC gate: you are not authorised</p>
                            <p style={{ margin: 0 }}>
                                {adminMessage ?? "Your account is not on the impersonation admin allow-list."} This is the
                                gate working as designed. To grant access for the demo, add your email to{" "}
                                <code style={styles.code}>IMPERSONATION_ADMIN_EMAILS</code> in{" "}
                                <code style={styles.code}>.env.local</code> (or set{" "}
                                <code style={styles.code}>IMPERSONATION_ALLOW_ANY_ADMIN=true</code> for local dev) and restart
                                the proxy.
                            </p>
                        </div>
                    )}
                </div>

                {/* Active session view */}
                {session && (
                    <div style={styles.card}>
                        <div style={styles.banner}>
                            ⚠ Impersonating <strong>{idLabel(session.subject)}</strong> — acting as{" "}
                            <strong>{idLabel(session.actor)}</strong>. Read-only · ends {fmtTime(session.expiresAt)}.
                        </div>
                        <h2 style={styles.sectionTitle}>Customer view (read-only)</h2>
                        <div style={styles.deviceFrame}>
                            <div style={styles.deviceBar}>Impersonated session</div>
                            <iframe
                                key={viewKey}
                                title="Impersonated customer view"
                                src={impersonationViewUrl()}
                                style={styles.iframe}
                            />
                        </div>
                        <div style={styles.detailGrid}>
                            <span style={styles.detailKey}>Session id</span>
                            <code style={styles.code}>{session.sessionId}</code>
                            <span style={styles.detailKey}>Acting admin</span>
                            <span>{idLabel(session.actor)}</span>
                            <span style={styles.detailKey}>Subject</span>
                            <span>{idLabel(session.subject)}{session.subject.name ? ` (${session.subject.name})` : ""}</span>
                            <span style={styles.detailKey}>Scope</span>
                            <span>{session.scope}</span>
                            <span style={styles.detailKey}>Justification</span>
                            <span>{session.reason}</span>
                            <span style={styles.detailKey}>Expires</span>
                            <span>{fmtTime(session.expiresAt)}</span>
                        </div>
                        <button type="button" style={styles.dangerButton} onClick={handleStop} disabled={busy}>
                            Stop impersonating
                        </button>
                    </div>
                )}

                {/* Start form (admins only) */}
                {isAdmin !== false && !session && (
                    <div style={styles.card}>
                        <h2 style={styles.sectionTitle}>Start an impersonation session</h2>
                        <form onSubmit={handleStart}>
                            <label style={styles.label} htmlFor="subjectEmail">
                                Customer email
                            </label>
                            <input
                                id="subjectEmail"
                                type="email"
                                style={styles.input}
                                value={subjectEmail}
                                onChange={(e) => setSubjectEmail(e.target.value)}
                                placeholder="customer@example.com"
                                required
                            />
                            <label style={styles.label} htmlFor="reason">
                                Justification (recorded in the audit log)
                            </label>
                            <input
                                id="reason"
                                type="text"
                                style={styles.input}
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder="e.g. Ticket #12345 — customer can't see their renewal"
                                required
                            />
                            <button type="submit" style={styles.primaryButton} disabled={busy}>
                                Start impersonation
                            </button>
                        </form>
                    </div>
                )}

                {/* Audit + live sessions (admins only) */}
                {isAdmin && (
                    <div style={styles.card}>
                        <h2 style={styles.sectionTitle}>Audit log</h2>
                        {activeSessions.length > 0 && (
                            <>
                                <p style={{ fontWeight: 700, margin: "0 0 0.5rem 0" }}>Live sessions</p>
                                <table style={styles.table}>
                                    <thead>
                                        <tr>
                                            <th style={styles.th}>Subject</th>
                                            <th style={styles.th}>Acting admin</th>
                                            <th style={styles.th}>Expires</th>
                                            <th style={styles.th}></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {activeSessions.map((s) => (
                                            <tr key={s.sessionId}>
                                                <td style={styles.td}>{idLabel(s.subject)}</td>
                                                <td style={styles.td}>{idLabel(s.actor)}</td>
                                                <td style={styles.td}>{fmtTime(s.expiresAt)}</td>
                                                <td style={styles.td}>
                                                    <button
                                                        type="button"
                                                        style={styles.revokeButton}
                                                        onClick={() => handleRevoke(s.sessionId)}
                                                        disabled={busy}
                                                    >
                                                        Revoke
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </>
                        )}

                        <p style={{ fontWeight: 700, margin: "1.25rem 0 0.5rem 0" }}>History</p>
                        {auditLog.length === 0 ? (
                            <p style={{ margin: 0, color: "#6b7280" }}>No impersonation activity yet.</p>
                        ) : (
                            <table style={styles.table}>
                                <thead>
                                    <tr>
                                        <th style={styles.th}>When</th>
                                        <th style={styles.th}>Action</th>
                                        <th style={styles.th}>Subject</th>
                                        <th style={styles.th}>Acting admin</th>
                                        <th style={styles.th}>Justification</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {auditLog.map((entry, i) => (
                                        <tr key={`${entry.sessionId}-${entry.action}-${i}`}>
                                            <td style={styles.td}>{new Date(entry.at).toLocaleString()}</td>
                                            <td style={styles.td}>{entry.action}</td>
                                            <td style={styles.td}>{idLabel(entry.subject)}</td>
                                            <td style={styles.td}>{idLabel(entry.actor)}</td>
                                            <td style={styles.td}>{entry.reason ?? "—"}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                )}
            </div>
        </main>
    );
}

function SignInPrompt() {
    const { instance, inProgress } = useMsal();
    return (
        <main style={styles.page}>
            <Hero />
            <div style={styles.wrap}>
                <div style={styles.card}>
                    <p style={styles.lead}>
                        Sign in first — the impersonation portal is an administrator tool, gated by an RBAC allow-list.
                    </p>
                    <button
                        type="button"
                        style={styles.primaryButton}
                        onClick={() => instance.loginRedirect(loginRequest)}
                        disabled={inProgress !== InteractionStatus.None}
                    >
                        Log in
                    </button>
                </div>
            </div>
        </main>
    );
}

export default function ImpersonatePage() {
    return (
        <>
            <AuthenticatedTemplate>
                <ImpersonationPortal />
            </AuthenticatedTemplate>
            <UnauthenticatedTemplate>
                <SignInPrompt />
            </UnauthenticatedTemplate>
        </>
    );
}
