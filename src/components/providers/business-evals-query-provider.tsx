"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"

export function BusinessEvalsQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 20_000,
          gcTime: 5 * 60_000,
          retry: (failureCount, error) => {
            const status = error && typeof error === "object" && "status" in error
              ? Number(error.status)
              : 0
            return status >= 400 && status < 500 ? false : failureCount < 2
          },
          refetchOnWindowFocus: false,
        },
        mutations: { retry: false },
      },
    })
  )

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
