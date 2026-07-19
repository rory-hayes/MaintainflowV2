import assert from "node:assert/strict"
import test from "node:test"
import {
  completeSupabaseOAuthFromLocation,
  completeSupabasePasswordResetFromLocation,
  getSupabaseGoogleOAuthUrl,
  hasSupabaseAuthRedirect,
  requestSupabasePasswordReset,
  readSupabaseSession,
  signUpWithSupabase,
  verifySupabaseSession,
  writeSupabaseSession,
} from "../src/lib/supabase/auth.ts"
import { getSupabaseConfig, SUPABASE_SESSION_KEY } from "../src/lib/supabase/config.ts"

const CODE_VERIFIER_KEY = `${SUPABASE_SESSION_KEY}-code-verifier`

function installBrowserWindow() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const storage = new Map<string, string>()
  let assignedUrl = ""
  const localStorage = {
    get length() {
      return storage.size
    },
    clear() {
      storage.clear()
    },
    getItem(key: string) {
      return storage.get(key) ?? null
    },
    key(index: number) {
      return Array.from(storage.keys())[index] ?? null
    },
    removeItem(key: string) {
      storage.delete(key)
    },
    setItem(key: string, value: string) {
      storage.set(key, value)
    },
  } satisfies Storage

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
      location: {
        origin: "https://www.maintainflow.io",
        assign(url: string) {
          assignedUrl = url
        },
      },
    },
  })

  return {
    storage,
    get assignedUrl() {
      return assignedUrl
    },
    restore() {
      if (originalWindow) {
        Object.defineProperty(globalThis, "window", originalWindow)
      } else {
        Reflect.deleteProperty(globalThis, "window")
      }
    },
  }
}

function configureSupabaseAuth() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://maintainflow.supabase.test"
  delete process.env.NEXT_PUBLIC_SUPABASE_AUTH_URL
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key"
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.maintainflow.io"
}

test("Supabase Google OAuth URL stores a PKCE verifier and requests an auth-code callback", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()

  try {
    const url = await getSupabaseGoogleOAuthUrl({ nextPath: "/dashboard" })
    const authorizeUrl = new URL(url)

    assert.equal(authorizeUrl.origin, "https://maintainflow.supabase.test")
    assert.equal(authorizeUrl.pathname, "/auth/v1/authorize")
    assert.equal(authorizeUrl.searchParams.get("provider"), "google")
    assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "s256")
    assert.ok(authorizeUrl.searchParams.get("code_challenge"))
    assert.ok(browser.storage.get(CODE_VERIFIER_KEY)?.length)

    const redirectTo = new URL(authorizeUrl.searchParams.get("redirect_to") ?? "")
    assert.equal(redirectTo.origin, "https://www.maintainflow.io")
    assert.equal(redirectTo.pathname, "/auth/callback")
    assert.equal(redirectTo.searchParams.get("next"), "/dashboard")
  } finally {
    browser.restore()
  }
})

test("Supabase Google OAuth rejects protocol-relative next paths", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()

  try {
    const url = await getSupabaseGoogleOAuthUrl({ nextPath: "//attacker.example/path" })
    const redirectTo = new URL(new URL(url).searchParams.get("redirect_to") ?? "")
    assert.equal(redirectTo.origin, "https://www.maintainflow.io")
    assert.equal(redirectTo.pathname, "/auth/callback")
    assert.equal(redirectTo.searchParams.has("next"), false)
  } finally {
    browser.restore()
  }
})

test("Supabase custom auth URL is used for OAuth while REST stays on the project URL", async () => {
  configureSupabaseAuth()
  process.env.NEXT_PUBLIC_SUPABASE_AUTH_URL = "https://auth.maintainflow.test"
  const browser = installBrowserWindow()

  try {
    const config = getSupabaseConfig()
    const url = await getSupabaseGoogleOAuthUrl({ nextPath: "/reports" })
    const authorizeUrl = new URL(url)

    assert.equal(config.supabaseUrl, "https://maintainflow.supabase.test")
    assert.equal(config.authUrl, "https://auth.maintainflow.test")
    assert.equal(config.restUrl, "https://maintainflow.supabase.test/rest/v1")
    assert.equal(authorizeUrl.origin, "https://auth.maintainflow.test")
    assert.equal(authorizeUrl.pathname, "/auth/v1/authorize")
    assert.equal(new URL(authorizeUrl.searchParams.get("redirect_to") ?? "").pathname, "/auth/callback")
  } finally {
    delete process.env.NEXT_PUBLIC_SUPABASE_AUTH_URL
    browser.restore()
  }
})

test("Supabase signup without returned user shows confirmation guidance instead of raw provider error", async () => {
  configureSupabaseAuth()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch

  try {
    await assert.rejects(
      signUpWithSupabase({
        name: "QA User",
        email: "qa@maintainflow.io",
        password: "strong-password",
        company: "QA Agency",
        role: "Operator",
      }),
      /Account created\. Check your email/
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Supabase auth redirect detector accepts root hash confirmation links", () => {
  assert.equal(hasSupabaseAuthRedirect({ hash: "#access_token=abc&refresh_token=def&type=signup", search: "" }), true)
  assert.equal(hasSupabaseAuthRedirect({ hash: "", search: "?code=oauth-code" }), true)
  assert.equal(hasSupabaseAuthRedirect({ hash: "", search: "?utm_source=launch" }), false)
})

test("Supabase Google OAuth callback exchanges auth code with the stored PKCE verifier", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalFetch = globalThis.fetch
  await getSupabaseGoogleOAuthUrl()
  const verifier = browser.storage.get(CODE_VERIFIER_KEY)
  const calls: Array<{ url: string; init?: RequestInit }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(
      JSON.stringify({
        access_token: "oauth-access",
        refresh_token: "oauth-refresh",
        expires_in: 3600,
        user: { id: "user-1", email: "ops@agency.com", user_metadata: { name: "Ops User" } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  }) as typeof fetch

  try {
    const user = await completeSupabaseOAuthFromLocation({ hash: "", search: "?code=oauth-code" })

    assert.equal(user.email, "ops@agency.com")
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://maintainflow.supabase.test/auth/v1/token?grant_type=pkce")
    assert.equal(calls[0].init?.method, "POST")
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      auth_code: "oauth-code",
      code_verifier: verifier,
    })
    assert.equal(browser.storage.has(CODE_VERIFIER_KEY), false)
    assert.equal(JSON.parse(browser.storage.get(SUPABASE_SESSION_KEY) ?? "{}").access_token, "oauth-access")
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("stored Supabase sessions are verified before restoring the user", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalFetch = globalThis.fetch
  const session = {
    access_token: "persisted-access",
    refresh_token: "persisted-refresh",
    expires_at: Date.now() + 3600_000,
    user: { id: "stale-user", email: "stale@agency.com" },
  }
  const calls: Array<{ url: string; init?: RequestInit }> = []

  writeSupabaseSession(session)
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(
      JSON.stringify({
        id: "fresh-user",
        email: "fresh@agency.com",
        user_metadata: { name: "Fresh User", company: "Fresh Agency" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  }) as typeof fetch

  try {
    const user = await verifySupabaseSession()
    const stored = readSupabaseSession()

    assert.equal(user?.id, "fresh-user")
    assert.equal(user?.email, "fresh@agency.com")
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://maintainflow.supabase.test/auth/v1/user")
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer persisted-access")
    assert.equal(stored?.user.id, "fresh-user")
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("expired Supabase sessions refresh silently before restoring the user", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []

  writeSupabaseSession({
    access_token: "expired-access",
    refresh_token: "persisted-refresh",
    expires_at: Date.now() - 1,
    user: { id: "user-1", email: "ops@agency.com" },
  })
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).includes("grant_type=refresh_token")) {
      return new Response(
        JSON.stringify({
          access_token: "refreshed-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          user: { id: "user-1", email: "ops@agency.com", user_metadata: { name: "Ops User" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }

    return new Response(
      JSON.stringify({ id: "user-1", email: "ops@agency.com", user_metadata: { name: "Ops User" } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  }) as typeof fetch

  try {
    const user = await verifySupabaseSession()
    const stored = readSupabaseSession()

    assert.equal(user?.email, "ops@agency.com")
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, "https://maintainflow.supabase.test/auth/v1/token?grant_type=refresh_token")
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { refresh_token: "persisted-refresh" })
    assert.equal(calls[1].url, "https://maintainflow.supabase.test/auth/v1/user")
    assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer refreshed-access")
    assert.equal(stored?.access_token, "refreshed-access")
    assert.equal(stored?.refresh_token, "rotated-refresh")
    assert.ok((stored?.expires_at ?? 0) > Date.now())
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("invalid stored Supabase sessions are cleared instead of restoring a deleted user", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalFetch = globalThis.fetch

  writeSupabaseSession({
    access_token: "deleted-user-access",
    refresh_token: "deleted-user-refresh",
    expires_at: Date.now() + 3600_000,
    user: { id: "deleted-user", email: "deleted@agency.com" },
  })
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "invalid_token", msg: "User not found" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch

  try {
    const user = await verifySupabaseSession()

    assert.equal(user, null)
    assert.equal(readSupabaseSession(), null)
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("Supabase password reset updates the password with the recovery access token", async () => {
  const originalFetch = globalThis.fetch
  configureSupabaseAuth()

  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ id: "user-1", email: "ops@agency.test" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch

  try {
    const user = await completeSupabasePasswordResetFromLocation(
      {
        hash: "#access_token=recovery-access&refresh_token=recovery-refresh&expires_in=3600&type=recovery",
        search: "",
      } as Location,
      { password: "new-secret", confirmPassword: "new-secret" }
    )

    assert.equal(user.email, "ops@agency.test")
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://maintainflow.supabase.test/auth/v1/user")
    assert.equal(calls[0].init?.method, "PUT")
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer recovery-access")
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { password: "new-secret" })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Supabase password reset request stores PKCE and sends a production reset URL", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
  }) as typeof fetch

  try {
    await requestSupabasePasswordReset("ops@agency.com")

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://maintainflow.supabase.test/auth/v1/recover")
    const body = JSON.parse(String(calls[0].init?.body))
    assert.equal(body.email, "ops@agency.com")
    assert.equal(body.redirect_to, "https://www.maintainflow.io/reset-password")
    assert.equal(body.code_challenge_method, "s256")
    assert.ok(body.code_challenge)
    assert.ok(browser.storage.get(CODE_VERIFIER_KEY)?.length)
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("Supabase password reset exchanges a recovery auth code before updating the password", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  browser.storage.set(CODE_VERIFIER_KEY, "stored-reset-verifier")
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).includes("/token?grant_type=pkce")) {
      return new Response(
        JSON.stringify({
          access_token: "recovery-access",
          refresh_token: "recovery-refresh",
          expires_in: 3600,
          user: { id: "user-1", email: "ops@agency.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }

    return new Response(JSON.stringify({ id: "user-1", email: "ops@agency.com" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch

  try {
    const user = await completeSupabasePasswordResetFromLocation(
      { hash: "", search: "?code=recovery-code" },
      { password: "new-secret", confirmPassword: "new-secret" }
    )

    assert.equal(user.email, "ops@agency.com")
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, "https://maintainflow.supabase.test/auth/v1/token?grant_type=pkce")
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      auth_code: "recovery-code",
      code_verifier: "stored-reset-verifier",
    })
    assert.equal(calls[1].url, "https://maintainflow.supabase.test/auth/v1/user")
    assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer recovery-access")
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { password: "new-secret" })
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("Supabase password reset validates matching passwords before network calls", async () => {
  const originalFetch = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = (async () => {
    fetchCalled = true
    return new Response("{}")
  }) as typeof fetch

  try {
    await assert.rejects(
      completeSupabasePasswordResetFromLocation(
        { hash: "#access_token=recovery-access&refresh_token=recovery-refresh", search: "" } as Location,
        { password: "new-secret", confirmPassword: "different" }
      ),
      /Passwords do not match/
    )
    assert.equal(fetchCalled, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
