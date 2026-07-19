import { AuthCard } from "@/components/auth/auth-card"
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Log in",
  robots: { index: false, follow: false },
}

export default function SignInPage() {
  return <AuthCard mode="login" />
}
