"use client"

import { useAuth } from "@/components/auth/auth-provider"
import { useCoreLoop } from "@/hooks/use-core-loop"
import { createContext, type ReactNode, useContext } from "react"

type CoreLoopContextValue = ReturnType<typeof useCoreLoop>

const CoreLoopContext = createContext<CoreLoopContextValue | null>(null)

export function CoreLoopProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const core = useCoreLoop(user)

  return <CoreLoopContext.Provider value={core}>{children}</CoreLoopContext.Provider>
}

export function useCoreLoopContext() {
  const core = useContext(CoreLoopContext)
  if (!core) {
    throw new Error("useCoreLoopContext must be used inside CoreLoopProvider.")
  }

  return core
}
