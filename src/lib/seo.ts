import type { Metadata } from "next"

export const siteUrl = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.maintainflow.io"
).replace(/\/$/, "")

export function absoluteUrl(path = "/") {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  return `${siteUrl}${normalizedPath}`
}

type SeoMetadataInput = {
  title: string
  description: string
  path: string
  keywords?: string[]
}

export function createSeoMetadata({
  title,
  description,
  path,
  keywords = [],
}: SeoMetadataInput): Metadata {
  return {
    title,
    description,
    keywords,
    alternates: {
      canonical: path,
    },
    openGraph: {
      title,
      description,
      url: absoluteUrl(path),
      siteName: "Maintain Flow",
      type: "website",
      images: [
        {
          url: "/assets/maintain-flow-mature-dashboard.png",
          width: 1600,
          height: 900,
          alt: "Maintain Flow workflow maintenance dashboard",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/assets/maintain-flow-mature-dashboard.png"],
    },
  }
}
