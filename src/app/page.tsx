import { AuthRedirectHandler } from "@/components/auth/auth-redirect-handler"
import BusinessEvalsLanding from "@/sections/business-evals-landing"

const HomePage = () => {
  return <><AuthRedirectHandler /><BusinessEvalsLanding /></>
}

export default HomePage
