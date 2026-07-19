"use client"

import {
  AuthUser,
  ensureDemoUser,
  getCurrentUser,
  signInWithLocalUser,
  signOutLocalUser,
  signUpWithLocalUser,
  updateStoredUser,
} from "@/lib/auth-storage"
import { trackProductEvent } from "@/lib/analytics/product-events"
import {
  clearSupabaseSession,
  completeSupabaseOAuthFromLocation,
  signInWithSupabase,
  signOutSupabase,
  signUpWithSupabase,
  startSupabaseGoogleOAuth,
  verifySupabaseSession,
} from "@/lib/supabase/auth"
import { getSupabaseConfig } from "@/lib/supabase/config"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"

type SignUpInput = Parameters<typeof signUpWithLocalUser>[0] & { nextPath?: string }
type SignInInput = Parameters<typeof signInWithLocalUser>[0]

type AuthContextValue = {
  ready: boolean
  user: AuthUser | null
  authMode: "supabase" | "local"
  signUp: (input: SignUpInput) => Promise<AuthUser>
  signIn: (input: SignInInput) => Promise<AuthUser>
  signInWithGoogle: (input?: { nextPath?: string }) => Promise<void>
  completeOAuthSignIn: (location: Location) => Promise<AuthUser>
  signOut: () => Promise<void>
  updateProfile: (input: Partial<Pick<AuthUser, "name" | "company" | "role">>) => AuthUser | null
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [user, setUser] = useState<AuthUser | null>(null)
  const authMode: AuthContextValue["authMode"] = getSupabaseConfig().enabled ? "supabase" : "local"

  useEffect(() => {
    let cancelled = false

    async function loadSession() {
      if (getSupabaseConfig().enabled) {
        const nextUser = await verifySupabaseSession()
        if (!cancelled) {
          setUser(nextUser)
        }
      } else {
        ensureDemoUser()
        clearSupabaseSession()
        if (!cancelled) {
          setUser(getCurrentUser())
        }
      }

      if (!cancelled) {
        setReady(true)
      }
    }

    loadSession()

    return () => {
      cancelled = true
    }
  }, [])

  const signUp = useCallback(async (input: SignUpInput) => {
    const nextUser = getSupabaseConfig().enabled ? await signUpWithSupabase(input) : signUpWithLocalUser(input)
    setUser(nextUser)
    trackProductEvent({ eventName: "signup_completed", metadata: { authMode } })
    trackProductEvent({ eventName: "sign_up_completed", metadata: { authMode } })
    return nextUser
  }, [authMode])

  const signIn = useCallback(async (input: SignInInput) => {
    const nextUser = getSupabaseConfig().enabled ? await signInWithSupabase(input) : signInWithLocalUser(input)
    setUser(nextUser)
    trackProductEvent({ eventName: "sign_in_completed", metadata: { authMode } })
    return nextUser
  }, [authMode])

  const signInWithGoogle = useCallback(async (input?: { nextPath?: string }) => {
    if (!getSupabaseConfig().enabled) {
      throw new Error("Google sign-in is not configured for Maintain Flow.")
    }

    trackProductEvent({ eventName: "google_oauth_started", metadata: { nextPath: input?.nextPath ?? "" } })
    await startSupabaseGoogleOAuth(input)
  }, [])

  const completeOAuthSignIn = useCallback(async (location: Location) => {
    if (!getSupabaseConfig().enabled) {
      throw new Error("Google sign-in is not configured for Maintain Flow.")
    }

    const nextUser = await completeSupabaseOAuthFromLocation(location)
    setUser(nextUser)
    trackProductEvent({ eventName: "oauth_completed", metadata: { authMode: "supabase" } })
    return nextUser
  }, [])

  const signOut = useCallback(async () => {
    trackProductEvent({ eventName: "signed_out", metadata: { authMode } })
    if (getSupabaseConfig().enabled) {
      await signOutSupabase()
    }
    signOutLocalUser()
    setUser(null)
  }, [authMode])

  const updateProfile = useCallback(
    (input: Partial<Pick<AuthUser, "name" | "company" | "role">>) => {
      const nextUser = updateStoredUser(input)
      setUser(nextUser)
      return nextUser
    },
    []
  )

  const value = useMemo(
    () => ({ ready, user, authMode, signUp, signIn, signInWithGoogle, completeOAuthSignIn, signOut, updateProfile }),
    [ready, user, authMode, signUp, signIn, signInWithGoogle, completeOAuthSignIn, signOut, updateProfile]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider.")
  }

  return context
}
