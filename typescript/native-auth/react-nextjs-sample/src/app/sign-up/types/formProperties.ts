import { FormProps } from "@/app/shared/types/formProperties";

export interface EmailStepProps extends FormProps {
    onSubmit: (e: React.FormEvent) => void;
    email: string;
    setEmail: (value: string) => void;
    onCancel: () => void;
    serverError?: string;
}

export interface EmailCodeStepProps extends FormProps {
    onSubmit: (e: React.FormEvent) => void;
    code: string;
    setCode: (value: string) => void;
    email: string;
    onCancel: () => void;
    onResend: () => void;
    serverError?: string;
    expectedCodeLength?: number;
}

export interface DetailsStepProps extends FormProps {
    onSubmit: (e: React.FormEvent) => Promise<void>;
    password: string;
    setPassword: (value: string) => void;
    confirmPassword: string;
    setConfirmPassword: (value: string) => void;
    givenName: string;
    setGivenName: (value: string) => void;
    familyName: string;
    setFamilyName: (value: string) => void;
    dateOfBirth: string;
    setDateOfBirth: (value: string) => void;
    termsAccepted: boolean;
    setTermsAccepted: (value: boolean) => void;
    onCancel: () => void;
}

export interface MobileStepProps extends FormProps {
    onSubmit: (e: React.FormEvent) => Promise<void>;
    mobileNumber: string;
    setMobileNumber: (value: string) => void;
    dialCode: string;
    setDialCode: (value: string) => void;
    onCancel: () => void;
}

export interface SmsCodeStepProps extends FormProps {
    onSubmit: (e: React.FormEvent) => Promise<void>;
    code: string;
    setCode: (value: string) => void;
    onCancel: () => void;
    onResend: () => void;
    mobileNumber: string;
    serverError?: string;
    expectedCodeLength?: number;
}
