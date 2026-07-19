import type { NextConfig } from "next";
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

export default withWorkflow(baseNextConfig);
