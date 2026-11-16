// Hub policy store (PLAN D74). The owner's authority over who may run sessions
// on their machine: per-requester, per-repo grants, a block list, and a short
// audit trail. Kept out of slack-config.json on purpose so it can be denied to
// the agent's own process (core/hub/sandbox.js) independently, and signed so a
// foreign edit is detected instead of silently honoured.
//
// The signature is tamper-EVIDENCE, not tamper-PREVENTION: the same OS user
// that runs the listener could in principle re-sign the file. What actually
// stops an agent from doing that is the sandbox denying it the home directory
// and the key. In a deployed (network) hub this store lives off the laptop.

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const GRANT_LEVELS = ['always', 'ask', 'readonly']
const POLICY_VERSION = 1
const AUDIT_LIMIT = 200
const KEYCHAIN_SERVICE = 'team-slack-bridge-hub'

// Canonical form must match what survives a JSON round trip, or a freshly
// written policy would fail its own signature check on the next read:
// undefined object members are dropped and undefined array members become null,
// exactly as JSON.stringify does.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(item => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sign(key, policy) {
  return createHmac('sha256', key).update(stableStringify(policy)).digest('hex')
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'hex')
  const right = Buffer.from(String(b), 'hex')
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

function keychainAccount(home) {
  return createHash('sha256').update(home).digest('hex').slice(0, 16)
}

function readKeychainKey(home) {
  try {
    return execFileSync('security', ['find-generic-password', '-a', keychainAccount(home), '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function writeKeychainKey(home, key) {
  try {
    execFileSync('security', ['add-generic-password', '-a', keychainAccount(home), '-s', KEYCHAIN_SERVICE, '-w', key, '-U'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

// macOS Keychain when available, else a 0600 key file inside the home. The
// file fallback is weaker (readable by anything running as the user that the
// sandbox does not cover) and is reported via `keySource` so doctor can say so.
export function loadOrCreateKey(home) {
  if (process.platform === 'darwin') {
    const existing = readKeychainKey(home)
    if (existing) return { key: existing, source: 'keychain' }
  }
  const keyPath = join(home, '.hub-key')
  if (existsSync(keyPath)) return { key: readFileSync(keyPath, 'utf8').trim(), source: 'file' }
  const fresh = randomBytes(32).toString('hex')
  if (process.platform === 'darwin' && writeKeychainKey(home, fresh)) return { key: fresh, source: 'keychain' }
  mkdirSync(home, { recursive: true })
  writeFileSync(keyPath, fresh + '\n', { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  return { key: fresh, source: 'file' }
}

function emptyPolicy(ownerId) {
  return { version: POLICY_VERSION, ownerId: ownerId || null, blocked: {}, grants: {}, audit: [] }
}

function parseExpiry(value, now) {
  if (value === undefined || value === null || value === '' || value === 'never') return null
  if (typeof value === 'number') return new Date(value).toISOString()
  const match = /^(\d+)\s*([mhd])$/i.exec(String(value).trim())
  if (!match) return undefined
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2].toLowerCase()]
  return new Date(now + Number(match[1]) * unit).toISOString()
}

export function createPolicyStore({ home, ownerId, now = () => Date.now() }) {
  if (!home) throw new Error('home required')
  const path = join(home, 'hub-policy.json')
  const { key, source: keySource } = loadOrCreateKey(home)
  let tamperedNotified = false

  function load() {
    if (!existsSync(path)) return { ok: true, policy: emptyPolicy(ownerId), fresh: true }
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return { ok: false, error: 'policy-unreadable' }
    }
    if (!parsed?.policy || !parsed?.sig || !safeEqualHex(parsed.sig, sign(key, parsed.policy))) {
      return { ok: false, error: 'policy-tampered' }
    }
    if (ownerId && parsed.policy.ownerId && parsed.policy.ownerId !== ownerId) {
      return { ok: false, error: 'policy-owner-mismatch' }
    }
    return { ok: true, policy: parsed.policy }
  }

  function persist(policy) {
    mkdirSync(home, { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ policy, sig: sign(key, policy) }, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, path)
    chmodSync(path, 0o600)
  }

  function mutate(fn, auditEntry) {
    const loaded = load()
    if (!loaded.ok) return loaded
    const policy = loaded.policy
    policy.ownerId = policy.ownerId || ownerId || null
    const result = fn(policy)
    if (result && result.ok === false) return result
    policy.audit = [...(policy.audit || []), { at: new Date(now()).toISOString(), ...auditEntry }].slice(-AUDIT_LIMIT)
    persist(policy)
    return { ok: true, ...(result || {}) }
  }

  return {
    path,
    keySource,

    // Reports tamper once per process so the owner is told, not spammed.
    consumeTamperNotice() {
      const loaded = load()
      if (loaded.ok || tamperedNotified) return null
      tamperedNotified = true
      return loaded.error
    },

    list() {
      return load()
    },

    isBlocked(userId) {
      const loaded = load()
      if (!loaded.ok) return true
      return Boolean(loaded.policy.blocked[userId])
    },

    // The one question every delegated start and every delegated prompt asks.
    // Fails closed on a tampered or unreadable policy.
    checkAccess({ userId, repo }) {
      const loaded = load()
      if (!loaded.ok) return { ok: false, reason: loaded.error }
      const { policy } = loaded
      if (policy.blocked[userId]) return { ok: false, reason: 'blocked' }
      const grant = policy.grants[userId]?.[repo]
      if (!grant) return { ok: false, reason: 'no-grant' }
      if (grant.expiresAt && Date.parse(grant.expiresAt) <= now()) return { ok: false, reason: 'expired' }
      return { ok: true, level: grant.level }
    },

    grant({ userId, repos, level = 'always', expires, by }) {
      if (!userId || !Array.isArray(repos) || !repos.length) return { ok: false, error: 'user-and-repos-required' }
      if (!GRANT_LEVELS.includes(level)) return { ok: false, error: 'invalid-level', allowed: GRANT_LEVELS }
      const expiresAt = parseExpiry(expires, now())
      if (expiresAt === undefined) return { ok: false, error: 'invalid-expiry' }
      return mutate(
        policy => {
          if (policy.blocked[userId]) return { ok: false, error: 'user-is-blocked' }
          policy.grants[userId] = policy.grants[userId] || {}
          for (const repo of repos) {
            policy.grants[userId][repo] = { level, grantedAt: new Date(now()).toISOString(), grantedBy: by || policy.ownerId, expiresAt }
          }
          return { granted: repos, level, expiresAt }
        },
        { action: 'grant', userId, repos, level, by }
      )
    },

    revoke({ userId, repos, by }) {
      if (!userId) return { ok: false, error: 'user-required' }
      return mutate(
        policy => {
          const existing = policy.grants[userId] || {}
          const targets = repos?.length ? repos : Object.keys(existing)
          const revoked = targets.filter(repo => existing[repo])
          for (const repo of revoked) delete existing[repo]
          if (!Object.keys(existing).length) delete policy.grants[userId]
          return { revoked }
        },
        { action: 'revoke', userId, repos, by }
      )
    },

    block({ userId, by }) {
      if (!userId) return { ok: false, error: 'user-required' }
      if (ownerId && userId === ownerId) return { ok: false, error: 'cannot-block-owner' }
      return mutate(
        policy => {
          policy.blocked[userId] = { at: new Date(now()).toISOString(), by: by || policy.ownerId }
          delete policy.grants[userId]
          return {}
        },
        { action: 'block', userId, by }
      )
    },

    unblock({ userId, by }) {
      if (!userId) return { ok: false, error: 'user-required' }
      return mutate(
        policy => {
          if (!policy.blocked[userId]) return { ok: false, error: 'user-not-blocked' }
          delete policy.blocked[userId]
          return {}
        },
        { action: 'unblock', userId, by }
      )
    },

    // For `tsb-hub resign` after the owner deliberately edited the file by hand.
    resign() {
      if (!existsSync(path)) return { ok: false, error: 'no-policy-file' }
      let parsed
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        return { ok: false, error: 'policy-unreadable' }
      }
      if (!parsed?.policy) return { ok: false, error: 'policy-unreadable' }
      persist(parsed.policy)
      tamperedNotified = false
      return { ok: true }
    },
  }
}
