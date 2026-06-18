import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Build/dev output directory. Overridable so a SECOND instance of this same
  // codebase (App B in the cross-app SSO spike) can run from the same folder:
  // Next refuses two dev servers sharing one project dir because they'd share the
  // `<distDir>/dev` lock. Pointing App B at a separate distDir
  // (NEXT_DIST_DIR=.next-appB) gives it its own lock so both can run at once.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Static export for Azure Static Web Apps (pure client-side SPA, no SSR/API routes).
  // Browser-delegated auth redirects straight to ciamlogin.com, so unlike the
  // native-auth sample there is no CORS proxy / managed API function to deploy.
  output: "export",
  // Emit each route as <route>/index.html so SWA resolves deep links cleanly.
  trailingSlash: true,
  // Passkey registration requires serving the dev app at a subdomain of the
  // tenant's relying-party domain (hosts-file mapping to 127.0.0.1) — allow that
  // origin to talk to the dev server. See README, "Passkeys".
  allowedDevOrigins: ["auth.myservicetasdevpoc.ciamlogin.com"],
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
