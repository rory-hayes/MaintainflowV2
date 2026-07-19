"use client"

import { normalizeEmailAddress, validateDeliverableEmail } from "./auth/email.ts"

export type AuthUser = {
  id: string
  name: string
  email: string
  company: string
  role: string
  createdAt: string
  lastLoginAt: string
}

type StoredUser = AuthUser & {
  password: string
}

type SignUpInput = {
  name: string
  email: string
  password: string
  company: string
  role: string
}

type SignInInput = {
  email: string
  password: string
}

const USERS_KEY = "maintain-flow-users"
const SESSION_KEY = "maintain-flow-session"
const RESET_KEY = "maintain-flow-reset-requests"

export const demoCredentials = {
  email: "demo@maintainflow.test",
  password: "maintainflow",
}

const demoUser: StoredUser = {
  id: "demo-user",
  name: "Demo Owner",
  email: demoCredentials.email,
  password: demoCredentials.password,
  company: "Northstar Studio",
  role: "Product Operator",
  createdAt: "2026-06-22T09:00:00.000Z",
  lastLoginAt: "2026-06-22T09:00:00.000Z",
}

function canUseStorage() {
  return typeof window !== "undefined" && "localStorage" in window
}

function safeParseUsers(value: string | null): StoredUser[] {
  if (!value) {
    return []
  }

  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function readUsers(): StoredUser[] {
  if (!canUseStorage()) {
    return []
  }

  return safeParseUsers(window.localStorage.getItem(USERS_KEY))
}

function writeUsers(users: StoredUser[]) {
  window.localStorage.setItem(USERS_KEY, JSON.stringify(users))
}

function readResetRequests(): Record<string, string> {
  if (!canUseStorage()) {
    return {}
  }

  try {
    return JSON.parse(window.localStorage.getItem(RESET_KEY) || "{}")
  } catch {
    return {}
  }
}

function writeResetRequests(requests: Record<string, string>) {
  window.localStorage.setItem(RESET_KEY, JSON.stringify(requests))
}

function publicUser(user: StoredUser): AuthUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    company: user.company,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  }
}

export function ensureDemoUser() {
  if (!canUseStorage()) {
    return
  }

  const users = readUsers()
  const exists = users.some((user) => user.email === demoUser.email)

  if (!exists) {
    writeUsers([demoUser, ...users])
  }
}

export function getCurrentUser() {
  if (!canUseStorage()) {
    return null
  }

  ensureDemoUser()

  const userId = window.localStorage.getItem(SESSION_KEY)
  if (!userId) {
    return null
  }

  const user = readUsers().find((item) => item.id === userId)
  return user ? publicUser(user) : null
}

export function signUpWithLocalUser(input: SignUpInput) {
  if (!canUseStorage()) {
    throw new Error("Local auth requires a browser environment.")
  }

  ensureDemoUser()

  const emailValidation = validateDeliverableEmail(input.email)
  const name = input.name.trim()
  const company = input.company.trim()
  const role = input.role.trim()
  const password = input.password.trim()

  if (!emailValidation.ok) {
    throw new Error(emailValidation.message)
  }

  if (!name || !company || !role || password.length < 6) {
    throw new Error("Add your name, email, company, role, and a 6+ character password.")
  }

  const email = emailValidation.email
  const users = readUsers()
  if (users.some((user) => user.email === email)) {
    throw new Error("An account already exists for that email. Log in instead.")
  }

  const now = new Date().toISOString()
  const user: StoredUser = {
    id: crypto.randomUUID(),
    name,
    email,
    password,
    company,
    role,
    createdAt: now,
    lastLoginAt: now,
  }

  writeUsers([user, ...users])
  window.localStorage.setItem(SESSION_KEY, user.id)

  return publicUser(user)
}

export function signInWithLocalUser(input: SignInInput) {
  if (!canUseStorage()) {
    throw new Error("Local auth requires a browser environment.")
  }

  ensureDemoUser()

  const email = normalizeEmailAddress(input.email)
  const password = input.password.trim()
  const users = readUsers()
  const user = users.find((item) => item.email === email && item.password === password)

  if (!user) {
    throw new Error("Email or password did not match a local account.")
  }

  const nextUser = {
    ...user,
    lastLoginAt: new Date().toISOString(),
  }

  writeUsers(users.map((item) => (item.id === nextUser.id ? nextUser : item)))
  window.localStorage.setItem(SESSION_KEY, nextUser.id)

  return publicUser(nextUser)
}

export function updateStoredUser(input: Partial<Pick<AuthUser, "name" | "company" | "role">>) {
  if (!canUseStorage()) {
    return null
  }

  const current = getCurrentUser()
  if (!current) {
    return null
  }

  const users = readUsers()
  const nextUsers = users.map((user) =>
    user.id === current.id
      ? {
          ...user,
          name: input.name?.trim() || user.name,
          company: input.company?.trim() || user.company,
          role: input.role?.trim() || user.role,
        }
      : user
  )

  writeUsers(nextUsers)
  const updated = nextUsers.find((user) => user.id === current.id)

  return updated ? publicUser(updated) : null
}

export function requestLocalPasswordReset(emailInput: string) {
  if (!canUseStorage()) {
    throw new Error("Local password reset requires a browser environment.")
  }

  ensureDemoUser()
  const email = normalizeEmailAddress(emailInput)
  const user = readUsers().find((item) => item.email === email)

  if (!user) {
    throw new Error("No local Maintain Flow account exists for that email.")
  }

  const token = crypto.randomUUID()
  writeResetRequests({ ...readResetRequests(), [email]: token })

  return {
    email,
    token,
    resetPath: `/reset-password?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`,
  }
}

export function resetLocalPassword(input: { email: string; token: string; password: string; confirmPassword: string }) {
  if (!canUseStorage()) {
    throw new Error("Local password reset requires a browser environment.")
  }

  ensureDemoUser()
  const email = normalizeEmailAddress(input.email)
  const password = input.password.trim()
  const confirmPassword = input.confirmPassword.trim()
  const resetRequests = readResetRequests()

  if (!email || resetRequests[email] !== input.token) {
    throw new Error("Reset link is invalid or expired.")
  }

  if (password.length < 6) {
    throw new Error("Use 6 or more characters.")
  }

  if (password !== confirmPassword) {
    throw new Error("Passwords do not match.")
  }

  const users = readUsers()
  const exists = users.some((user) => user.email === email)
  if (!exists) {
    throw new Error("No local Maintain Flow account exists for that email.")
  }

  writeUsers(users.map((user) => (user.email === email ? { ...user, password } : user)))
  delete resetRequests[email]
  writeResetRequests(resetRequests)
}

export function signOutLocalUser() {
  if (!canUseStorage()) {
    return
  }

  window.localStorage.removeItem(SESSION_KEY)
}
