import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { withWorkflow } from "workflow/next";
import { buildProductionSecurityHeaders } from "./src/lib/security/headers.ts";

export const baseNextConfig: NextConfig = {
  output: "standalone",
  devIndicators: false,
  images: {
    remotePatterns: [],
    qualities: [25, 35, 50, 75, 100],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: buildProductionSecurityHeaders(),
      },
      {
        source: "/share/reports/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
};

export default withSentryConfig(withWorkflow(baseNextConfig), {
  sentryUrl: "https://sentry.io",
  telemetry: false,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
});
