import type { Metadata } from "next";
import { Nunito } from "next/font/google";
import Navbar from "@/components/Navbar";
import { AuthProvider } from "@/auth/AuthProvider";
import "./globals.css";

const nunito = Nunito({
  variable: "--font-nunito",
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  style: ["normal", "italic"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Entra External ID POC (browser-delegated)",
  description: "Browser-delegated Entra External ID POC for Service Tasmania",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={nunito.variable}>
        <AuthProvider>
          <Navbar />
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
