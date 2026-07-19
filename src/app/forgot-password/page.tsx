import { PasswordResetCard } from "@/components/auth/password-reset-card"
import { Suspense } from "react"

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <PasswordResetCard mode="forgot" />
    </Suspense>
  )
}
