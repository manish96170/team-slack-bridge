// Config loading and handle resolution (PLAN §4.4). No hardcoded handles —
// identity mapping is per-install config, never baked into code.

import { readFileSync, existsSync } from 'node:fs'

export function loadConfig(path) {
  if (!existsSync(path)) {
    return { users: [], watchedChannels: [], owner: {}, dmAllowlist: [], remote: { postableChannels: [], readableChannels: [] } }
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  return {
    users: raw.users || [],
    watchedChannels: raw.watchedChannels || [],
    owner: raw.owner || {},
    dmAllowlist: raw.dmAllowlist || [],
    remote: {
      postableChannels: raw.remote?.postableChannels || [],
      readableChannels: raw.remote?.readableChannels || [],
    },
  }
}

function matchesUser(user, handleOrName) {
  const needle = handleOrName.toLowerCase().replace(/^@/, '')
  return (
    user.name?.toLowerCase() === needle ||
    user.slackHandle?.toLowerCase().replace(/^@/, '') === needle ||
    user.slackUserId === handleOrName
  )
}

// `configuredOnly` is the remote-profile limit (§11.6 #4): only handles
// present in slack-config.json's `users` list resolve on remote. Local
// carries the same restriction today — live directory lookup via
// `users.list` is a documented follow-on, not built yet.
export function resolveUser(handleOrName, config) {
  if (!handleOrName) return { ok: false, error: 'handle-required', retryable: false }
  const found = config.users.find(user => matchesUser(user, handleOrName))
  if (!found) return { ok: false, error: 'user-not-configured', retryable: false }
  return { ok: true, userId: found.slackUserId, name: found.name }
}

// Turns literal "@handle" text into a real Slack mention (`<@USERID>`) —
// added 2026-09-09 because a plain "@PJ" in posted text is never rendered
// as a tag by Slack; only the `<@USERID>` syntax is. Only handles present
// in slack-config.json's `users` list resolve — an unmatched "@word" is
// left exactly as typed rather than guessed at or stripped, since a wrong
// substitution (tagging the wrong person) is worse than no substitution.
const MENTION_PATTERN = /@([A-Za-z0-9_.-]+)/g

export function resolveMentions(text, config) {
  if (!text || !config) return text
  return text.replace(MENTION_PATTERN, (match, handle) => {
    const resolved = resolveUser(`@${handle}`, config)
    return resolved.ok ? `<@${resolved.userId}>` : match
  })
}
