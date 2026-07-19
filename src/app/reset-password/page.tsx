import { PasswordResetCard } from "@/components/auth/password-reset-card"
import { Suspense } from "react"

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <PasswordResetCard mode="reset" />
    </Suspense>
  )
}
