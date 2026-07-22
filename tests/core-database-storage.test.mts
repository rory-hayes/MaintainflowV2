import assert from "node:assert/strict"
import test from "node:test"
import { signOutLocalUser } from "../src/lib/auth-storage.ts"
import { CORE_DB_KEY, clearCoreDatabase, emptyCoreDatabase, readCoreDatabase, writeCoreDatabase } from "../src/lib/core/local-store.ts"

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key) {
      return values.get(key) ?? null
    },
    key(index) {
      return [...values.keys()][index] ?? null
    },
    removeItem(key) {
      values.delete(key)
    },
    setItem(key, value) {
      values.set(key, value)
    },
  }
}

test("production workspace snapshots stay in session storage and are purgeable", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const localStorage = memoryStorage()
  const sessionStorage = memoryStorage()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage, sessionStorage },
  })

  try {
    const database = emptyCoreDatabase()
    database.agencies.push({
      id: "agency_1",
      name: "Private workspace",
      slug: "private-workspace",
      plan: "free",
      trialEndsAt: null,
      stripeCustomerId: "",
      stripeSubscriptionId: "",
      reportSenderName: "Owner",
      reportSenderEmail: "owner@example.test",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    })

    writeCoreDatabase(database, "session")
    assert.equal(localStorage.getItem(CORE_DB_KEY), null)
    assert.ok(sessionStorage.getItem(CORE_DB_KEY))
    assert.equal(readCoreDatabase("session").agencies[0]?.name, "Private workspace")

    clearCoreDatabase("session")
    assert.equal(sessionStorage.getItem(CORE_DB_KEY), null)
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }
  }
})

test("sign out clears local and session workspace snapshots", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const localStorage = memoryStorage()
  const sessionStorage = memoryStorage()
  localStorage.setItem("maintain-flow-session", "user_1")
  localStorage.setItem(CORE_DB_KEY, "local snapshot")
  sessionStorage.setItem(CORE_DB_KEY, "session snapshot")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage, sessionStorage },
  })

  try {
    signOutLocalUser()
    assert.equal(localStorage.getItem("maintain-flow-session"), null)
    assert.equal(localStorage.getItem(CORE_DB_KEY), null)
    assert.equal(sessionStorage.getItem(CORE_DB_KEY), null)
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }
  }
})
