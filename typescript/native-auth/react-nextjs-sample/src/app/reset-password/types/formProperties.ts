import { FormProps } from "@/app/shared/types/formProperties";

export interface ResetPasswordInitialFormProps extends FormProps {
    onSubmit: (e: React.FormEvent) => Promise<void> | void;
    username: string;
    setUsername: (value: string) => void;
}

export interface VerifyIdentityStepProps extends FormProps {
    onSubmit: (e: React.FormEvent) => void;
    onCancel: () => void;
    maskedMobile?: string;
}

export interface ResetNewPasswordStepProps extends FormProps {
    onSubmit: (e: React.FormEvent) => Promise<void> | void;
    password: string;
    setPassword: (value: string) => void;
    confirmPassword: string;
    setConfirmPassword: (value: string) => void;
    onCancel: () => void;
    serverError?: string;
}
