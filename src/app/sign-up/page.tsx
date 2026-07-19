import { AuthCard } from "@/components/auth/auth-card"
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Create your account",
  robots: { index: false, follow: false },
}

export default function SignUpPage() {
  return <AuthCard mode="signup" />
}
