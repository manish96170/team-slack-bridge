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
// A hard stop against a runaway/infinite-cursor walk, not a deliberate
// business limit — found too low live (D69): a real company's workspace
// had 5,144 members across 26 pages, and the original MAX_PAGES=20
// (4,000 members) silently truncated the walk before reaching page 24,
// where the specific person being searched for actually was. The walk
// still returned `{ ok: true, members }` with no error and no indication
// anything was missing, so a real, eligible, non-deleted member resolved
// to a false `user-not-found` with nothing to suggest why. Raised to a
// number no real single Slack workspace is expected to hit (Slack's own
// workspace member limits are far below this), while still bounding the
// genuinely-pathological case this constant exists for.
export const MAX_PAGES = 250

// token -> { members, expiresAt, truncated }. Deliberately NEVER stores an
// error here — a missing_scope or network failure must be visible on the
// very next call, not silently repeated for the whole TTL window.
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

async function fetchAllMembers({ token, slackCall, ttlMs, onDirectoryMembers }) {
  const cached = directoryCache.get(token)
  if (cached && cached.expiresAt > Date.now()) {
    const result = { ok: true, members: cached.members, truncated: cached.truncated }
    if (onDirectoryMembers) await onDirectoryMembers(result)
    return result
  }

  const members = []
  let cursor
  let page = 0
  for (; page < MAX_PAGES; page++) {
    const result = await slackCall('users.list', token, { limit: 200, cursor })
    if (!result.ok) return result // never cache a failed page
    members.push(...(result.members || []))
    cursor = result.response_metadata?.next_cursor
    if (!cursor) break
  }
  // Still more pages left when the loop stopped — the walk hit MAX_PAGES
  // itself, not a genuine end of the directory (Slack sets next_cursor to
  // '' once there's nothing left). Cache the partial result (still better
  // than refetching every call) but mark it so callers can tell "not
  // found" apart from "not found in what we were able to fetch."
  const truncated = page >= MAX_PAGES && !!cursor
  const result = { ok: true, members, truncated }
  directoryCache.set(token, { members, expiresAt: Date.now() + (ttlMs ?? DEFAULT_TTL_MS), truncated })
  if (onDirectoryMembers) await onDirectoryMembers(result)
  return result
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
export async function searchDirectoryByHandleOrName({ token, query, slackCall = callSlack, includeEmail = false, ttlMs, tokenSource = 'bot', onDirectoryMembers }) {
  if (!query || !query.trim()) return { ok: false, error: 'query-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }

  const needle = normalize(query)
  const fetched = await fetchAllMembers({ token, slackCall, ttlMs, onDirectoryMembers })
  if (!fetched.ok) return mapSlackFailure(fetched, 'users:read')

  const matches = fetched.members.filter(member => {
    if (!isEligible(member)) return false
    return [member.name, member.profile?.display_name, member.real_name, member.profile?.real_name].some(candidate => normalize(candidate) === needle)
  })

  if (matches.length === 0) return { ok: false, error: 'user-not-found', retryable: false, ...(fetched.truncated ? { truncated: true } : {}) }
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

export async function lookupUser({ query, mode = 'auto', token, slackCall = callSlack, includeEmail = false, ttlMs, tokenSource = 'bot', onDirectoryMembers }) {
  if (!query || !query.trim()) return { ok: false, error: 'query-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }

  const resolvedMode = mode && mode !== 'auto' ? mode : isSlackUserId(query) ? 'id' : isEmailAddress(query) ? 'email' : 'handle'

  if (resolvedMode === 'id') return lookupUserById({ token, userId: query, slackCall, includeEmail, tokenSource })
  if (resolvedMode === 'email') return lookupUserByEmail({ token, email: query, slackCall, includeEmail, tokenSource })
  // 'handle' and 'name' are the same search — see searchDirectoryByHandleOrName.
  return searchDirectoryByHandleOrName({ token, query, slackCall, includeEmail, ttlMs, tokenSource, onDirectoryMembers })
}
