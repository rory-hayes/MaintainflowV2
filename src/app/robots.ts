import type { MetadataRoute } from "next"

import { siteUrl } from "@/lib/seo"

const privateRoutePrefixes = [
  "/api/",
  "/auth/",
  "/business-evals-fixtures/",
  "/control-room/",
  "/share/reports/",
  "/projects",
  "/journeys",
  "/eval-runs",
  "/incidents",
  "/reports",
  "/settings",
  "/clients",
  "/workflows",
  "/issues",
] as const

const privateExactRoutes = [
  "/action-center",
  "/checks",
  "/dashboard",
  "/forgot-password",
  "/onboarding",
  "/reset-password",
  "/sign-in",
  "/sign-up",
] as const

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [...privateRoutePrefixes, ...privateExactRoutes],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
