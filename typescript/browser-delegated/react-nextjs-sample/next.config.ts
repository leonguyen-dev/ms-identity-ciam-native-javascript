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
  // The unified HTTPS dev host serves the app from subdomains of the tenant's
  // relying-party domain (hosts-file mappings to 127.0.0.1), not localhost, so
  // Next's cross-origin dev-server guard would otherwise block HMR and other
  // internal dev requests (the `_next/webpack-hmr` WebSocket fails). Allow both
  // app hosts: `auth.` (App A / passkeys) and `app-b.` (App B / cross-app SSO).
  // See README, "Run everything over HTTPS (unified dev host)".
  allowedDevOrigins: [
    "auth.myservicetasdevpoc.ciamlogin.com",
    "app-b.myservicetasdevpoc.ciamlogin.com",
  ],
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
