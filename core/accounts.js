// Local-profile-only multi-account registry (PLAN D21). Absent entirely
// from the remote/hosted profile — mcp/tools.remote.js and mcp/http.js never
// import this file, by construction, same as D6 intends.
//
// When accounts.json doesn't exist, every function here behaves as if there
// were exactly one account named "default" pointing at today's
// TSB_HOME/~/.team-slack-bridge — so nothing changes for anyone who never
// touches this feature.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadContextForHome } from '../cli/context.js'

// Read lazily, not as a module-level constant — this env var is only ever
// meant to be stable for the life of one process, but reading it per-call
// (cheap) rather than at import time makes this module trivially testable
// with a temp TSB_HOME instead of needing cache-busting dynamic imports.
function rootHome() {
  return process.env.TSB_HOME || join(homedir(), '.team-slack-bridge')
}

export function getAccountsRegistryPath() {
  return join(rootHome(), 'accounts.json')
}

function readRegistry() {
  const path = getAccountsRegistryPath()
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeRegistry(registry) {
  mkdirSync(rootHome(), { recursive: true })
  writeFileSync(getAccountsRegistryPath(), JSON.stringify(registry, null, 2) + '\n')
}

export function listAccounts() {
  const raw = readRegistry()
  if (!raw) return { default: 'default', accounts: { default: rootHome() } }
  const accounts = {}
  for (const [name, entry] of Object.entries(raw.accounts || {})) accounts[name] = entry.home
  return { default: raw.default || Object.keys(accounts)[0] || 'default', accounts }
}

export function resolveAccountHome(name) {
  const { default: defaultName, accounts } = listAccounts()
  const resolvedName = name || defaultName
  const home = accounts[resolvedName]
  if (!home) return { ok: false, error: 'account-not-found', name: resolvedName, retryable: false }
  return { ok: true, name: resolvedName, home }
}

export function loadAccountContext(name) {
  const resolved = resolveAccountHome(name)
  if (!resolved.ok) return resolved
  return { ok: true, accountName: resolved.name, ...loadContextForHome(resolved.home) }
}

export function addAccount(name, home) {
  if (!name || !home) return { ok: false, error: 'name-and-home-required', retryable: false }
  const registry = readRegistry() || { default: 'default', accounts: { default: { home: rootHome() } } }
  registry.accounts = registry.accounts || {}
  registry.accounts[name] = { home }
  if (!registry.default) registry.default = name
  writeRegistry(registry)
  return { ok: true, name, home }
}

export function removeAccount(name) {
  const registry = readRegistry()
  if (!registry?.accounts?.[name]) return { ok: false, error: 'account-not-found', retryable: false }
  delete registry.accounts[name]
  if (registry.default === name) registry.default = Object.keys(registry.accounts)[0]
  writeRegistry(registry)
  return { ok: true, name }
}

export function setDefaultAccount(name) {
  const registry = readRegistry()
  if (!registry?.accounts?.[name]) return { ok: false, error: 'account-not-found', retryable: false }
  registry.default = name
  writeRegistry(registry)
  return { ok: true, name }
}
