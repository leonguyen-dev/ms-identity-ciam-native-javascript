import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Static export for Azure Static Web Apps (pure client-side SPA, no SSR/API routes).
  output: "export",
  // Emit each route as <route>/index.html so SWA resolves deep links cleanly.
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
