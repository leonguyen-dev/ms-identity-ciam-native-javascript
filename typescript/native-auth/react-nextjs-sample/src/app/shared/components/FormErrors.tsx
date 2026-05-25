import type { CSSProperties } from "react";

export interface FormError {
    id?: string;
    message: string;
}

interface ErrorSummaryProps {
    errors: FormError[];
    heading?: string;
}

interface FieldErrorProps {
    message: string;
    id?: string;
}

const formErrorStyles: Record<string, CSSProperties> = {
    summary: {
        border: "1px solid #b91c1c",
        backgroundColor: "#fecaca",
        padding: "1.25rem 1.5rem",
        color: "#b91c1c",
    },
    heading: {
        fontSize: "1rem",
        fontWeight: 400,
        color: "#b91c1c",
        marginBottom: "0.75rem",
    },
    list: {
        listStyle: "none",
        padding: 0,
        margin: 0,
        display: "flex",
        flexDirection: "column",
        gap: "0.15rem",
    },
    item: {
        display: "flex",
        alignItems: "flex-start",
        gap: "0.5rem",
    },
    link: {
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        color: "#b91c1c",
        fontSize: "1rem",
        fontWeight: 700,
        textDecoration: "underline",
        textAlign: "left",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        lineHeight: 1.4,
    },
    linkDisabled: {
        background: "none",
        border: "none",
        padding: 0,
        cursor: "default",
        color: "#b91c1c",
        fontSize: "1rem",
        fontWeight: 700,
        textDecoration: "underline",
        textAlign: "left",
        fontFamily: "var(--font-nunito), 'Nunito', sans-serif",
        lineHeight: 1.4,
    },
    fieldError: {
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        color: "#b91c1c",
        fontSize: "1rem",
        fontWeight: 700,
        textDecoration: "underline",
        marginTop: "-1.5rem",
    },
    icon: {
        flexShrink: 0,
        color: "#b91c1c",
        display: "inline-block",
        verticalAlign: "middle",
    },
};

export function WarningIcon({ size = 20 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
            style={formErrorStyles.icon}
        >
            <path d="M10 1.5 0.75 17.5h18.5L10 1.5Zm0.875 13.25h-1.75v-1.75h1.75v1.75Zm0-3h-1.75V7.5h1.75v4.25Z" />
        </svg>
    );
}

export function ErrorSummary({
    errors,
    heading = "The form could not be submitted for the following reasons:",
}: ErrorSummaryProps) {
    if (errors.length === 0) return null;

    const handleClick = (id?: string) => {
        if (!id) return;
        const el = document.getElementById(id);
        if (el) {
            el.focus();
            el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    };

    return (
        <div style={formErrorStyles.summary} role="alert">
            <div style={formErrorStyles.heading}>{heading}</div>
            <ul style={formErrorStyles.list}>
                {errors.map((err, idx) => (
                    <li key={idx} style={formErrorStyles.item}>
                        <WarningIcon />
                        {err.id ? (
                            <button
                                type="button"
                                style={formErrorStyles.link}
                                onClick={() => handleClick(err.id)}
                            >
                                {err.message}
                            </button>
                        ) : (
                            <span style={formErrorStyles.linkDisabled}>{err.message}</span>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function FieldError({ message, id }: FieldErrorProps) {
    return (
        <div id={id} style={formErrorStyles.fieldError}>
            <WarningIcon />
            <span>{message}</span>
        </div>
    );
}
