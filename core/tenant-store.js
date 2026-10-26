// Multi-tenancy Phase 2 (ROADMAP.md's "Multi-tenancy as a configurable
// deployment mode"), hand-provisioning half: a tenant registry for the
// hosted/remote profile, addressed by Slack team_id instead of an
// operator-chosen name.
//
// Deliberately NOT "an encrypted blob holding bot tokens" — it is the exact
// same shape as core/accounts.js (D21): team_id -> home directory. The home
// directory holds its own .env/slack-config.json/.ledger.sqlite, written
// 0600 and self-healing on every write (D44), exactly like today's single
// TSB_HOME or a local D21 account. No secret of any tenant's ever enters
// tenants.json itself, so there is no blob to encrypt and no key to manage —
// a stronger guarantee than application-level encryption would have been,
// and it reuses loadContextForHome() (built for D21) instead of a second
// config-loading path.
//
// Still local-profile-shaped in its storage, but this file IS imported by
// the hosted/remote path (core/tenancy.js) once tenancyMode:"multi" is set —
// unlike core/accounts.js, which D21/D6 keep local-only by construction.

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadContextForHome } from '../cli/context.js'

const TEAM_ID_RE = /^[A-Za-z0-9]+$/

function rootHome() {
  return process.env.TSB_HOME || join(homedir(), '.team-slack-bridge')
}

export function getTenantRegistryPath() {
  return join(rootHome(), 'tenants.json')
}

// The conventional default home for a tenant added without an explicit
// --home — nested under this deployment's own TSB_HOME so "list tenants"
// and "look at what's on disk" agree without extra bookkeeping. An operator
// who wants a tenant's data on a different disk/mount can still pass
// --home explicitly; this is only the default.
export function defaultTenantHome(teamId) {
  return join(rootHome(), 'tenants', teamId)
}

function readRegistry() {
  const path = getTenantRegistryPath()
  if (!existsSync(path)) return { tenants: {} }
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeRegistry(registry) {
  mkdirSync(rootHome(), { recursive: true })
  const path = getTenantRegistryPath()
  writeFileSync(path, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
}

function isValidTeamId(teamId) {
  return typeof teamId === 'string' && teamId.length > 0 && TEAM_ID_RE.test(teamId)
}

export function listTenants() {
  const { tenants } = readRegistry()
  return { ok: true, tenants }
}

export function addTenant(teamId, { home, enterpriseId } = {}) {
  if (!isValidTeamId(teamId)) return { ok: false, error: 'invalid-team-id', retryable: false }
  const registry = readRegistry()
  const resolvedHome = home || defaultTenantHome(teamId)
  registry.tenants[teamId] = { home: resolvedHome, enterpriseId: enterpriseId || null, addedAt: new Date().toISOString() }
  writeRegistry(registry)
  return { ok: true, teamId, home: resolvedHome }
}

export function removeTenant(teamId) {
  const registry = readRegistry()
  if (!registry.tenants[teamId]) return { ok: false, error: 'tenant-not-found', retryable: false }
  delete registry.tenants[teamId]
  writeRegistry(registry)
  return { ok: true, teamId }
}

export function resolveTenantHome(teamId) {
  if (!teamId) return { ok: false, error: 'team-id-required', retryable: false }
  const { tenants } = readRegistry()
  const entry = tenants[teamId]
  if (!entry) return { ok: false, error: 'tenant-not-found', retryable: false }
  return { ok: true, teamId, home: entry.home, enterpriseId: entry.enterpriseId }
}

// The one function core/tenancy.js's resolveAccount() actually calls.
// Mirrors core/accounts.js's loadAccountContext() exactly, keyed by
// team_id instead of an operator-chosen account name.
export function resolveTenantContext(teamId) {
  const resolved = resolveTenantHome(teamId)
  if (!resolved.ok) return resolved
  return { ok: true, teamId, enterpriseId: resolved.enterpriseId, ...loadContextForHome(resolved.home) }
}
