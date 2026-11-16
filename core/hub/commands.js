// Pure text parsing for the hub (PLAN D74): owner control commands, the owner's
// reply to an approval card, and the "on <person>" delegation syntax. No I/O,
// so every rule here is cheap to reason about. Slack-asserted sender identity
// is checked by the caller; nothing parsed here is trusted on its own.

import { GRANT_LEVELS } from './policy.js'

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/
const BARE_USER_ID = /^[UW][A-Z0-9]{2,}$/

export function extractUserId(token) {
  if (!token) return null
  const mention = USER_MENTION.exec(token)
  if (mention) return mention[1]
  return BARE_USER_ID.test(token.trim()) ? token.trim() : null
}

function splitRepos(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function keyValues(tokens) {
  const values = {}
  const rest = []
  for (const token of tokens) {
    const match = /^(repos?|level|expires?)=(.*)$/i.exec(token)
    if (match) values[match[1].toLowerCase().replace(/^repos$/, 'repo').replace(/^expires$/, 'expire')] = match[2]
    else rest.push(token)
  }
  return { values, rest }
}

// `grant <@U..> repo=api,web level=ask expires=7d`, `revoke <@U..> [repo=api]`,
// `block <@U..>`, `unblock <@U..>`, `grants`, `stop`, `restart`.
// Returns null when the text is not a hub command at all, so the caller can
// fall through to ordinary handling.
export function parseOwnerCommand(text) {
  const tokens = (text || '').trim().split(/\s+/).filter(Boolean)
  const name = (tokens[0] || '').toLowerCase()
  if (name === 'grants') return { name: 'grants' }
  if (name === 'stop' || name === 'restart') return { name }
  if (!['grant', 'revoke', 'block', 'unblock'].includes(name)) return null

  const { values, rest } = keyValues(tokens.slice(1))
  const userId = extractUserId(rest[0])
  if (!userId) return { name, error: 'user-required', usage: usageFor(name) }
  const repos = values.repo ? splitRepos(values.repo) : []
  if (name === 'grant') {
    if (!repos.length) return { name, error: 'repos-required', usage: usageFor(name) }
    const level = values.level ? values.level.toLowerCase() : undefined
    if (level && !GRANT_LEVELS.includes(level)) return { name, error: 'invalid-level', usage: usageFor(name) }
    return { name, userId, repos, level, expires: values.expire }
  }
  return { name, userId, repos }
}

function usageFor(name) {
  return {
    grant: '`grant @user repo=api,web [level=always|ask|readonly] [expires=7d]`',
    revoke: '`revoke @user [repo=api,web]` (no repo = revoke everything)',
    block: '`block @user`',
    unblock: '`unblock @user`',
  }[name]
}

// The owner's free-text answer to an approval card: `api, web` approves those
// repos; `all` approves exactly the repo that was asked about; `no`/`deny`
// refuses. A trailing `level=ask` sets the level. Repo names must exist in the
// registry: an unknown one is reported back and nothing is granted by guess.
export function parseApprovalReply(text, { requestedRepo, knownRepos }) {
  const tokens = (text || '').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return { ok: false, error: 'empty-reply' }
  const { values, rest } = keyValues(tokens)
  const joined = rest.join(' ').toLowerCase()
  if (['no', 'deny', 'denied', 'reject', 'none', 'nope'].includes(joined)) return { ok: true, decision: 'deny' }

  const level = values.level ? values.level.toLowerCase() : undefined
  if (level && !GRANT_LEVELS.includes(level)) return { ok: false, error: 'invalid-level' }

  const requested = splitRepos(rest.join(' '))
  const repos = requested.flatMap(item => (['all', 'yes', 'ok', 'approve', 'allow'].includes(item.toLowerCase()) ? [requestedRepo] : [item]))
  const unique = [...new Set(repos)]
  if (!unique.length) return { ok: false, error: 'empty-reply' }
  const unknown = unique.filter(repo => !knownRepos.includes(repo))
  if (unknown.length) return { ok: false, error: 'unknown-repos', unknown, knownRepos }
  return { ok: true, decision: 'grant', repos: unique, level }
}

// "on Daniel Reed: fix the login bug", "- Daniel Reed: ...", "on <@U123>: ...",
// `--on "Daniel Reed" ...`. `explicit` is true for forms that cannot be a
// normal task sentence (mention, quotes, --on, leading dash); a bare
// "on <words>:" is ambiguous with a task that merely starts with "on", so the
// caller falls back to a local start when such a name matches no one.
export function parseDelegation(text) {
  const input = (text || '').replace(/^\s+/, '')
  if (!input) return null

  let match = /^(?:on|for|--on|-)\s*<@([UW][A-Z0-9]+)(?:\|[^>]*)?>\s*[:,-]?\s*([\s\S]*)$/i.exec(input)
  if (match) return { target: { userId: match[1] }, rest: match[2].trim(), explicit: true }

  match = /^(?:on|for|--on|-)\s+"([^"]{1,80})"\s*[:,-]?\s*([\s\S]*)$/i.exec(input)
  if (match) return { target: { name: match[1].trim() }, rest: match[2].trim(), explicit: true }

  match = /^(--on|-)\s+([^:]{1,80}?)\s*:\s*([\s\S]*)$/i.exec(input)
  if (match && !match[2].includes('--')) return { target: { name: match[2].trim() }, rest: match[3].trim(), explicit: true }

  match = /^(?:on|for)\s+([^:]{1,60}?)\s*:\s*([\s\S]*)$/i.exec(input)
  if (match && !match[1].includes('--') && match[1].split(/\s+/).length <= 5) {
    return { target: { name: match[1].trim() }, rest: match[2].trim(), explicit: false }
  }
  return null
}
