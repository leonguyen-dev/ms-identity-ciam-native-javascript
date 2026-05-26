import { FormProps } from "@/app/shared/types/formProperties";

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
    stepIndicator?: string;
}
