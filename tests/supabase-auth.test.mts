import assert from "node:assert/strict"
import test from "node:test"
import {
  captureAndScrubEmailConfirmationLocation,
  captureAndScrubPasswordResetLocation,
  completeSupabaseEmailConfirmationFromLocation,
  completeSupabaseOAuthFromLocation,
  completeSupabasePasswordResetFromLocation,
  getSupabaseGoogleOAuthUrl,
  hasSupabaseAuthRedirect,
  requestSupabasePasswordReset,
  readSupabaseSession,
  signInWithSupabase,
  signUpWithSupabase,
  startSupabaseGoogleOAuth,
  verifySupabaseSession,
  writeSupabaseSession,
} from "../src/lib/supabase/auth.ts"
import { getSupabaseConfig, SUPABASE_SESSION_KEY } from "../src/lib/supabase/config.ts"
import { currentLegalAcceptance } from "../src/lib/legal/acceptance.ts"

const CODE_VERIFIER_KEY = `${SUPABASE_SESSION_KEY}-code-verifier`
const codeVerifierKey = (purpose: "oauth") => `${CODE_VERIFIER_KEY}:${purpose}`

function installBrowserWindow() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const storage = new Map<string, string>()
  const sessionValues = new Map<string, string>()
  let assignedUrl = ""
  function memoryStorage(values: Map<string, string>) {
    return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key: string) {
      return values.get(key) ?? null
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null
    },
    removeItem(key: string) {
      values.delete(key)
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
    } satisfies Storage
  }
  const localStorage = memoryStorage(storage)
  const sessionStorage = memoryStorage(sessionValues)

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
      sessionStorage,
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
    sessionValues,
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
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_test_public_key_1234567890"
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.maintainflow.io"
}

test("Supabase password auth fails before network access for an unapproved production origin", async () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalFetch = globalThis.fetch
  Object.defineProperty(process.env, "NODE_ENV", { configurable: true, enumerable: true, writable: true, value: "production" })
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://credential-capture.example"
  process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF = "abcdefghij1234567890"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_test_public_key_1234567890"
  let fetched = false
  globalThis.fetch = (async () => {
    fetched = true
    return Response.json({})
  }) as typeof fetch

  try {
    await assert.rejects(
      signInWithSupabase({ email: "owner@example.com", password: "do-not-send" }),
      /approved project/
    )
    assert.equal(fetched, false)
  } finally {
    if (originalNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV")
    else Object.defineProperty(process.env, "NODE_ENV", { configurable: true, enumerable: true, writable: true, value: originalNodeEnv })
    globalThis.fetch = originalFetch
    configureSupabaseAuth()
    delete process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF
  }
})

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
    assert.ok(browser.storage.get(codeVerifierKey("oauth"))?.length)

    const redirectTo = new URL(authorizeUrl.searchParams.get("redirect_to") ?? "")
    assert.equal(redirectTo.origin, "https://www.maintainflow.io")
    assert.equal(redirectTo.pathname, "/auth/callback")
    assert.equal(redirectTo.searchParams.get("next"), "/dashboard")
  } finally {
    browser.restore()
  }
})

test("Supabase PKCE fails closed when secure browser cryptography is unavailable", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto")
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  })

  try {
    await assert.rejects(getSupabaseGoogleOAuthUrl(), /secure browser randomness/)
    assert.equal(browser.storage.has(codeVerifierKey("oauth")), false)
  } finally {
    if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto)
    else Reflect.deleteProperty(globalThis, "crypto")
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

test("Supabase signup sends a cross-device confirmation redirect without browser-bound PKCE", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalFetch = globalThis.fetch
  let signupRequest: RequestInit | undefined
  let signupUrl = ""
  globalThis.fetch = (async (url, init) => {
    signupUrl = String(url)
    signupRequest = init
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch

  try {
    await assert.rejects(
      signUpWithSupabase({
        name: "QA User",
        email: "qa@maintainflow.io",
        password: "strong-password",
        company: "QA Agency",
        role: "Operator",
        legalAcceptance: currentLegalAcceptance("email_signup"),
      }),
      /Account created\. Check your email/
    )
    const body = JSON.parse(String(signupRequest?.body))
    assert.deepEqual(body.data.maintainflow_legal_acceptance, {
      accepted: true,
      terms_version: "2026-07-19",
      privacy_version: "2026-07-19",
      source: "email_signup",
    })
    const redirectTo = new URL(new URL(signupUrl).searchParams.get("redirect_to") ?? "")
    assert.equal(redirectTo.pathname, "/auth/confirm")
    assert.equal(redirectTo.searchParams.get("flow"), "signup")
    assert.equal(body.code_challenge_method, undefined)
    assert.equal(body.code_challenge, undefined)
    assert.equal(Array.from(browser.storage.keys()).some((key) => key.includes("code-verifier:signup")), false)
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("an accidentally auto-confirmed signup revokes provider tokens and never installs a browser session", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith("/auth/v1/logout?scope=global")) {
      return Response.json({})
    }
    return Response.json({
      access_token: "unexpected-signup-access",
      refresh_token: "unexpected-signup-refresh",
      expires_in: 3600,
      user: { id: "auto-confirmed-user", email: "auto-confirmed@agency.com" },
    })
  }) as typeof fetch

  try {
    await assert.rejects(
      signUpWithSupabase({
        name: "Auto Confirmed",
        email: "auto-confirmed@agency.com",
        password: "strong-password",
        company: "Agency",
        role: "Operator",
        legalAcceptance: currentLegalAcceptance("email_signup"),
      }),
      /Check your email/
    )
    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, "https://maintainflow.supabase.test/auth/v1/logout?scope=global")
    assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer unexpected-signup-access")
    assert.equal(readSupabaseSession(), null)
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("password sign-in rejects and revokes a pending email-signup activation", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url))
    if (String(url).endsWith("/rest/v1/rpc/current_auth_account_activation_status")) {
      return Response.json([{ activation_required: true, activation_complete: false }])
    }
    if (String(url).endsWith("/auth/v1/logout?scope=global")) {
      return Response.json({})
    }
    return Response.json({
      access_token: "pending-access",
      refresh_token: "pending-refresh",
      expires_in: 3600,
      user: { id: "pending-user", email: "pending@agency.com" },
    })
  }) as typeof fetch

  try {
    await assert.rejects(
      signInWithSupabase({ email: "pending@agency.com", password: "strong-password" }),
      /Confirm your email/
    )
    assert.deepEqual(calls, [
      "https://maintainflow.supabase.test/auth/v1/token?grant_type=password",
      "https://maintainflow.supabase.test/rest/v1/rpc/current_auth_account_activation_status",
      "https://maintainflow.supabase.test/auth/v1/logout?scope=global",
    ])
    assert.equal(readSupabaseSession(), null)
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("Supabase auth redirect detector accepts only query-bound auth-code callbacks", () => {
  assert.equal(hasSupabaseAuthRedirect({ hash: "#access_token=abc&refresh_token=def&type=signup", search: "" }), false)
  assert.equal(hasSupabaseAuthRedirect({ hash: "", search: "?code=oauth-code" }), true)
  assert.equal(hasSupabaseAuthRedirect({ hash: "", search: "?utm_source=launch" }), false)
})

test("Supabase OAuth rejects crafted hash sessions before network or storage access", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalFetch = globalThis.fetch
  let fetched = false
  globalThis.fetch = (async () => {
    fetched = true
    return Response.json({})
  }) as typeof fetch

  try {
    await assert.rejects(
      completeSupabaseOAuthFromLocation({
        hash: "#access_token=attacker-access&refresh_token=attacker-refresh&expires_in=3600&type=signup",
        search: "",
      }),
      /cannot sign you in automatically/
    )
    assert.equal(fetched, false)
    assert.equal(browser.storage.has(codeVerifierKey("oauth")), false)
    assert.equal(readSupabaseSession(), null)
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("email confirmation submits only its typed token hash to the same-origin action", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return Response.json({ ok: true, data: { confirmed: true } })
  }) as typeof fetch

  try {
    const result = await completeSupabaseEmailConfirmationFromLocation({
      hash: "#token_hash=confirmation-token-hash&type=email",
      search: "?flow=signup",
    })
    assert.deepEqual(result, { confirmed: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "/api/auth/email-action")
    assert.equal(calls[0].init?.method, "POST")
    assert.equal(calls[0].init?.credentials, "same-origin")
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      type: "email",
      tokenHash: "confirmation-token-hash",
    })
    assert.equal(readSupabaseSession(), null)
    assert.equal(Array.from(browser.storage.keys()).some((key) => key.includes("code-verifier:signup")), false)
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("Supabase Google OAuth callback exchanges auth code with the stored PKCE verifier", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalFetch = globalThis.fetch
  await startSupabaseGoogleOAuth({
    nextPath: "/projects",
    legalAcceptance: currentLegalAcceptance("oauth_callback"),
  })
  const verifier = browser.storage.get(codeVerifierKey("oauth"))
  const calls: Array<{ url: string; init?: RequestInit }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url) === "/api/legal/acceptance") {
      return Response.json({
        ok: true,
        data: {
          accepted: true,
          termsVersion: "2026-07-19",
          privacyVersion: "2026-07-19",
          acceptedAt: "2026-07-20T10:00:00.000Z",
        },
      })
    }
    if (String(url).endsWith("/rest/v1/rpc/current_auth_account_activation_status")) {
      return Response.json([{ activation_required: false, activation_complete: true }])
    }
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
    const user = await completeSupabaseOAuthFromLocation({ hash: "", search: "?code=oauth-code&next=%2Fprojects" })

    assert.equal(user.email, "ops@agency.com")
    assert.equal(calls.length, 3)
    assert.equal(calls[0].url, "https://maintainflow.supabase.test/auth/v1/token?grant_type=pkce")
    assert.equal(calls[0].init?.method, "POST")
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      auth_code: "oauth-code",
      code_verifier: verifier,
    })
    assert.equal(calls[1].url, "/api/legal/acceptance")
    assert.equal(calls[1].init?.method, "POST")
    assert.match(String((calls[1].init?.headers as Record<string, string>)["Idempotency-Key"]), /^legal-oauth:/)
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), currentLegalAcceptance("oauth_callback"))
    assert.equal(calls[2].url, "https://maintainflow.supabase.test/rest/v1/rpc/current_auth_account_activation_status")
    assert.equal(browser.storage.has(codeVerifierKey("oauth")), false)
    assert.equal(browser.sessionValues.size, 0)
    assert.equal(JSON.parse(browser.storage.get(SUPABASE_SESSION_KEY) ?? "{}").access_token, "oauth-access")
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("an auth-code callback without pending browser acceptance trusts only the durable current row", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalFetch = globalThis.fetch
  await getSupabaseGoogleOAuthUrl({ nextPath: "/onboarding" })
  const calls: Array<{ url: string; init?: RequestInit }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url) === "/api/legal/acceptance") {
      return Response.json({
        ok: true,
        data: {
          accepted: true,
          termsVersion: "2026-07-19",
          privacyVersion: "2026-07-19",
          acceptedAt: "2026-07-20T10:00:00.000Z",
        },
      })
    }
    if (String(url).endsWith("/rest/v1/rpc/current_auth_account_activation_status")) {
      return Response.json([{ activation_required: false, activation_complete: true }])
    }
    return Response.json({
      access_token: "email-confirmation-access",
      refresh_token: "email-confirmation-refresh",
      expires_in: 3600,
      user: { id: "email-user-1", email: "confirmed@agency.com", user_metadata: { name: "Confirmed User" } },
    })
  }) as typeof fetch

  try {
    const user = await completeSupabaseOAuthFromLocation({
      hash: "",
      search: "?code=email-confirmation-code&next=%2Fonboarding",
    })

    assert.equal(user.id, "email-user-1")
    assert.equal(calls.length, 3)
    assert.equal(calls[1].url, "/api/legal/acceptance")
    assert.equal(calls[1].init?.method, undefined)
    assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer email-confirmation-access")
    assert.equal(calls[2].url, "https://maintainflow.supabase.test/rest/v1/rpc/current_auth_account_activation_status")
    assert.equal(readSupabaseSession()?.access_token, "email-confirmation-access")
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("auth callback fails closed and stores no session when durable acceptance is missing", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalFetch = globalThis.fetch
  await getSupabaseGoogleOAuthUrl()

  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url) === "/api/legal/acceptance") {
      return Response.json({
        ok: true,
        data: {
          accepted: false,
          termsVersion: "2026-07-19",
          privacyVersion: "2026-07-19",
          acceptedAt: null,
        },
      })
    }
    return Response.json({
      access_token: "unaccepted-access",
      refresh_token: "unaccepted-refresh",
      expires_in: 3600,
      user: { id: "unaccepted-user", email: "unaccepted@agency.com" },
    })
  }) as typeof fetch

  try {
    await assert.rejects(
      completeSupabaseOAuthFromLocation({ hash: "", search: "?code=unaccepted-code" }),
      /current Terms and Privacy acceptance could not be verified/
    )
    assert.equal(readSupabaseSession(), null)
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
    if (String(url).endsWith("/rest/v1/rpc/current_auth_account_activation_status")) {
      return Response.json([{ activation_required: false, activation_complete: true }])
    }
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
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, "https://maintainflow.supabase.test/auth/v1/user")
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer persisted-access")
    assert.equal(calls[1].url, "https://maintainflow.supabase.test/rest/v1/rpc/current_auth_account_activation_status")
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

    if (String(url).endsWith("/rest/v1/rpc/current_auth_account_activation_status")) {
      return Response.json([{ activation_required: false, activation_complete: true }])
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
    assert.equal(calls.length, 3)
    assert.equal(calls[0].url, "https://maintainflow.supabase.test/auth/v1/token?grant_type=refresh_token")
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { refresh_token: "persisted-refresh" })
    assert.equal(calls[1].url, "https://maintainflow.supabase.test/auth/v1/user")
    assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer refreshed-access")
    assert.equal(calls[2].url, "https://maintainflow.supabase.test/rest/v1/rpc/current_auth_account_activation_status")
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

test("Supabase invitation activation updates the password with a typed invite access token", async () => {
  const originalFetch = globalThis.fetch
  configureSupabaseAuth()

  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url) === "/api/legal/acceptance") {
      return Response.json({
        ok: true,
        data: {
          accepted: true,
          termsVersion: "2026-07-19",
          privacyVersion: "2026-07-19",
          acceptedAt: "2026-07-20T10:00:00.000Z",
        },
      })
    }
    return new Response(JSON.stringify({ id: "user-1", email: "ops@agency.test" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch

  try {
    const user = await completeSupabasePasswordResetFromLocation(
      {
        hash: "#access_token=recovery-access&refresh_token=recovery-refresh&expires_in=3600&type=invite",
        search: "",
      } as Location,
      {
        password: "new-secret",
        confirmPassword: "new-secret",
        legalAcceptance: currentLegalAcceptance("password_reset"),
      }
    )

    assert.ok("email" in user)
    assert.equal(user.email, "ops@agency.test")
    assert.equal(calls.length, 3)
    assert.equal(calls[0].url, "/api/legal/acceptance")
    assert.equal(calls[0].init?.method, "POST")
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), currentLegalAcceptance("password_reset"))
    assert.equal(calls[1].url, "https://maintainflow.supabase.test/auth/v1/user")
    assert.equal(calls[1].init?.method, "PUT")
    assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer recovery-access")
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { password: "new-secret" })
    assert.equal(calls[2].url, "https://maintainflow.supabase.test/auth/v1/logout?scope=global")
    assert.equal((calls[2].init?.headers as Record<string, string>).Authorization, "Bearer recovery-access")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("email confirmation token hashes are captured before the browser URL is scrubbed", () => {
  const calls: Array<{ data: unknown; title: string; url?: string | URL | null }> = []
  const snapshot = captureAndScrubEmailConfirmationLocation(
    { hash: "#token_hash=confirmation-token-hash&type=email", search: "?flow=signup&next=%2Fonboarding" },
    {
      replaceState(data: unknown, title: string, url?: string | URL | null) {
        calls.push({ data, title, url })
      },
    }
  )

  assert.deepEqual(snapshot, {
    hash: "#token_hash=confirmation-token-hash&type=email",
    search: "?flow=signup&next=%2Fonboarding",
  })
  assert.deepEqual(calls, [{ data: null, title: "", url: "/auth/confirm" }])
})

test("password action credentials are captured before the browser URL is scrubbed", () => {
  const calls: Array<{ data: unknown; title: string; url?: string | URL | null }> = []
  const snapshot = captureAndScrubPasswordResetLocation(
    { hash: "#token_hash=recovery-token-hash&type=recovery", search: "?flow=recovery" },
    {
      replaceState(data: unknown, title: string, url?: string | URL | null) {
        calls.push({ data, title, url })
      },
    }
  )

  assert.deepEqual(snapshot, {
    hash: "#token_hash=recovery-token-hash&type=recovery",
    search: "?flow=recovery",
  })
  assert.deepEqual(calls, [{ data: null, title: "", url: "/reset-password" }])
})

test("crafted recovery token fragments are rejected before network access", async () => {
  const originalFetch = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = (async () => {
    fetchCalled = true
    return Response.json({})
  }) as typeof fetch

  try {
    await assert.rejects(
      completeSupabasePasswordResetFromLocation(
        {
          hash: "#access_token=attacker-access&refresh_token=attacker-refresh&type=recovery",
          search: "",
        },
        {
          password: "new-secret",
          confirmPassword: "new-secret",
          legalAcceptance: currentLegalAcceptance("password_reset"),
        }
      ),
      /invalid or expired/
    )
    assert.equal(fetchCalled, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Supabase password reset request sends a cross-device redirect without browser-bound PKCE", async () => {
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
    assert.equal(body.redirect_to, "https://www.maintainflow.io/reset-password?flow=recovery")
    assert.equal(body.code_challenge_method, undefined)
    assert.equal(body.code_challenge, undefined)
    assert.equal(Array.from(browser.storage.keys()).some((key) => key.includes("code-verifier:recovery")), false)
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("Supabase password reset submits its token hash, password, and exact legal acceptance only to the same-origin action", async () => {
  configureSupabaseAuth()
  const browser = installBrowserWindow()
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return Response.json({ ok: true, data: { passwordUpdated: true } })
  }) as typeof fetch

  try {
    const result = await completeSupabasePasswordResetFromLocation(
      { hash: "#token_hash=recovery-token-hash&type=recovery", search: "?flow=recovery" },
      {
        password: "new-secret",
        confirmPassword: "new-secret",
        legalAcceptance: currentLegalAcceptance("password_reset"),
      }
    )

    assert.deepEqual(result, { passwordUpdated: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "/api/auth/email-action")
    assert.equal(calls[0].init?.method, "POST")
    assert.equal(calls[0].init?.credentials, "same-origin")
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      type: "recovery",
      tokenHash: "recovery-token-hash",
      password: "new-secret",
      legalAcceptance: currentLegalAcceptance("password_reset"),
    })
    assert.equal(readSupabaseSession(), null)
    assert.equal(Array.from(browser.storage.keys()).some((key) => key.includes("code-verifier:recovery")), false)
  } finally {
    globalThis.fetch = originalFetch
    browser.restore()
  }
})

test("Supabase password activation fails before changing the password when legal evidence cannot be recorded", async () => {
  configureSupabaseAuth()
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return Response.json(
      { ok: false, error: { message: "The acceptance could not be stored." } },
      { status: 500 }
    )
  }) as typeof fetch

  try {
    await assert.rejects(
      completeSupabasePasswordResetFromLocation(
        { hash: "#access_token=recovery-access&refresh_token=recovery-refresh&type=invite", search: "" } as Location,
        {
          password: "new-secret",
          confirmPassword: "new-secret",
          legalAcceptance: currentLegalAcceptance("password_reset"),
        }
      ),
      /acceptance could not be stored/
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "/api/legal/acceptance")
  } finally {
    globalThis.fetch = originalFetch
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
        {
          password: "new-secret",
          confirmPassword: "different",
          legalAcceptance: currentLegalAcceptance("password_reset"),
        }
      ),
      /Passwords do not match/
    )
    assert.equal(fetchCalled, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
