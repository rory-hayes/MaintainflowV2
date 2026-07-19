import { ProductAnalytics } from "@/components/analytics/product-analytics";
import { PublicMarketingAnalytics } from "@/components/analytics/public-marketing-analytics";
import { LegacyCoreLoopBoundary } from "@/components/app/legacy-core-loop-boundary";
import { AuthProvider } from "@/components/auth/auth-provider";
import { SiteShell } from "@/components/layout/site-shell";
import { BusinessEvalsQueryProvider } from "@/components/providers/business-evals-query-provider";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { siteUrl } from "@/lib/seo";
import type { Metadata } from "next";
import "./globals.css";

const socialTitle = "Business Evals for Critical Customer Journeys | Maintain Flow";
const socialDescription = "Deterministic, reviewable evidence that approved Lead form and Trial signup journeys still reach the intended business outcome.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: socialTitle,
  description: socialDescription,
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "Maintain Flow",
    title: socialTitle,
    description: socialDescription,
  },
  twitter: {
    card: "summary_large_image",
    title: socialTitle,
    description: socialDescription,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased font-sans">
        <ThemeProvider>
          <AuthProvider>
            <BusinessEvalsQueryProvider>
              <LegacyCoreLoopBoundary>
              <ProductAnalytics />
              <PublicMarketingAnalytics />
              <SiteShell>{children}</SiteShell>
              </LegacyCoreLoopBoundary>
            </BusinessEvalsQueryProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
