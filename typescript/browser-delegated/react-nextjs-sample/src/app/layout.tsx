import type { Metadata } from "next";
import { Nunito } from "next/font/google";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { AuthProvider } from "@/auth/AuthProvider";
import { SsoBootstrap } from "@/auth/SsoBootstrap";
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
          <SsoBootstrap />
          <Navbar />
          <div style={{ flex: 1 }}>{children}</div>
          <Footer />
        </AuthProvider>
      </body>
    </html>
  );
}
