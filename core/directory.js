// Live Slack-directory lookup (PLAN D50) — resolves people who are NOT
// necessarily in slack-config.json, straight from Slack's own API. This is
// deliberately a separate capability from core/identity.js's resolveUser:
// that one stays configured-only, fast, and deterministic (PLAN §4.4's "no
// hardcoded handles" plus every existing caller's expectation of zero
// network calls); this one is a live, workspace-wide lookup that costs a
// real Slack API round trip (and, for handle/name search, a cached but
// still real directory walk).
//
// Uses the shared BOT token by default (PLAN §0's "bot is shared
// infrastructure" principle, same as every other bot-token tool), with an
// explicit opt-in to the user token instead — never a silent fallback.
// `tokenSource` ('bot' or 'user') is a caller-supplied label, not inferred,
// and is stamped on every successful result so a caller never has to guess
// which identity actually answered.

import { callSlack } from './slack.js'

const DEFAULT_TTL_MS = 10 * 60 * 1000 // 10 minutes — PLAN D50's "5-15 minute TTL"
const MAX_PAGES = 20 // hard stop against a runaway paginated walk, not a tuning knob

// token -> { members, expiresAt }. Deliberately NEVER stores an error here
// — a missing_scope or network failure must be visible on the very next
// call, not silently repeated for the whole TTL window.
const directoryCache = new Map()

export function clearDirectoryCache(token) {
  if (token) directoryCache.delete(token)
  else directoryCache.clear()
}

function isSlackUserId(query) {
  return /^[UW][A-Z0-9]{6,}$/i.test(query.trim())
}

function isEmailAddress(query) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query.trim())
}

// "remove one leading @, trim whitespace, compare case-insensitively" (D50) —
// applied identically to the query and to every candidate field compared
// against it, so "@Jane.Doe" and "jane.doe" and " jane.doe " all match.
function normalize(value) {
  return (value || '').trim().replace(/^@/, '').toLowerCase()
}

function isEligible(member) {
  return !!member && !member.deleted && !member.is_bot && member.id !== 'USLACKBOT'
}

function toPublicUser(member, { includeEmail = false } = {}) {
  return {
    id: member.id,
    displayName: member.profile?.display_name || member.profile?.real_name || member.real_name || member.name || null,
    realName: member.real_name || member.profile?.real_name || null,
    handle: member.name || null,
    email: includeEmail ? member.profile?.email || null : null,
  }
}

function mapSlackFailure(result, requiredScope) {
  if (result.error === 'missing_scope') return { ok: false, error: 'missing_scope', requiredScope, retryable: false }
  return { ok: false, error: result.error, retryable: !!result.retryable }
}

async function fetchAllMembers({ token, slackCall, ttlMs }) {
  const cached = directoryCache.get(token)
  if (cached && cached.expiresAt > Date.now()) return { ok: true, members: cached.members }

  const members = []
  let cursor
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await slackCall('users.list', token, { limit: 200, cursor })
    if (!result.ok) return result // never cache a failed page
    members.push(...(result.members || []))
    cursor = result.response_metadata?.next_cursor
    if (!cursor) break
  }
  directoryCache.set(token, { members, expiresAt: Date.now() + (ttlMs ?? DEFAULT_TTL_MS) })
  return { ok: true, members }
}

export async function lookupUserById({ token, userId, slackCall = callSlack, includeEmail = false, tokenSource = 'bot' }) {
  if (!userId || !userId.trim()) return { ok: false, error: 'query-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }

  const result = await slackCall('users.info', token, { user: userId.trim() })
  if (!result.ok) {
    if (result.error === 'user_not_found') return { ok: false, error: 'user-not-found', retryable: false }
    return mapSlackFailure(result, 'users:read')
  }
  if (!isEligible(result.user)) return { ok: false, error: 'user-not-found', retryable: false }
  return { ok: true, source: 'slack-directory', tokenSource, user: toPublicUser(result.user, { includeEmail }) }
}

export async function lookupUserByEmail({ token, email, slackCall = callSlack, includeEmail = false, tokenSource = 'bot' }) {
  if (!email || !email.trim()) return { ok: false, error: 'query-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }

  const result = await slackCall('users.lookupByEmail', token, { email: email.trim() })
  if (!result.ok) {
    if (result.error === 'users_not_found') return { ok: false, error: 'user-not-found', retryable: false }
    return mapSlackFailure(result, 'users:read.email')
  }
  if (!isEligible(result.user)) return { ok: false, error: 'user-not-found', retryable: false }
  return { ok: true, source: 'slack-directory', tokenSource, user: toPublicUser(result.user, { includeEmail }) }
}

// Handle AND display-name/real-name search share one code path — Slack has
// no separate endpoint for "handle" vs "name", and the request explicitly
// wants both compared against the same normalized query. Slack does not
// guarantee a handle is globally unique, so more than one eligible match
// is reported as `ambiguous-user` with every match listed, never resolved
// to an arbitrary pick.
export async function searchDirectoryByHandleOrName({ token, query, slackCall = callSlack, includeEmail = false, ttlMs, tokenSource = 'bot' }) {
  if (!query || !query.trim()) return { ok: false, error: 'query-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }

  const needle = normalize(query)
  const fetched = await fetchAllMembers({ token, slackCall, ttlMs })
  if (!fetched.ok) return mapSlackFailure(fetched, 'users:read')

  const matches = fetched.members.filter(member => {
    if (!isEligible(member)) return false
    return [member.name, member.profile?.display_name, member.real_name, member.profile?.real_name].some(candidate => normalize(candidate) === needle)
  })

  if (matches.length === 0) return { ok: false, error: 'user-not-found', retryable: false }
  if (matches.length > 1) {
    return {
      ok: false,
      error: 'ambiguous-user',
      retryable: false,
      matches: matches.map(member => ({
        id: member.id,
        displayName: member.profile?.display_name || member.real_name || member.name || null,
        handle: member.name || null,
      })),
    }
  }
  return { ok: true, source: 'slack-directory', tokenSource, user: toPublicUser(matches[0], { includeEmail }) }
}

export async function lookupUser({ query, mode = 'auto', token, slackCall = callSlack, includeEmail = false, ttlMs, tokenSource = 'bot' }) {
  if (!query || !query.trim()) return { ok: false, error: 'query-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }

  const resolvedMode = mode && mode !== 'auto' ? mode : isSlackUserId(query) ? 'id' : isEmailAddress(query) ? 'email' : 'handle'

  if (resolvedMode === 'id') return lookupUserById({ token, userId: query, slackCall, includeEmail, tokenSource })
  if (resolvedMode === 'email') return lookupUserByEmail({ token, email: query, slackCall, includeEmail, tokenSource })
  // 'handle' and 'name' are the same search — see searchDirectoryByHandleOrName.
  return searchDirectoryByHandleOrName({ token, query, slackCall, includeEmail, ttlMs, tokenSource })
}
