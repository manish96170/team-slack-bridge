// The authorized human's own Slack status, presence and Do Not Disturb
// (D72) — the natural companion to away mode: "heads down for an hour".
// User-token only; these change how the human appears to everyone else.
//
//   users.profile.set (users.profile:write)  — status text/emoji/expiry
//   users.setPresence (users:write)           — auto | away
//   dnd.setSnooze / dnd.endSnooze / dnd.info  — dnd:write / dnd:read

import { callSlack } from './slack.js'

const MAX_STATUS_LENGTH = 100
const MAX_SNOOZE_MINUTES = 24 * 60

function emojiName(value) {
  if (!value) return ''
  const bare = String(value).trim().replace(/^:+|:+$/g, '')
  return bare ? `:${bare}:` : ''
}

export async function setStatus({ token, text, emoji, expiresInMinutes, clear, dryRun, now = Date.now(), slackCall = callSlack }) {
  if (!clear && text === undefined && emoji === undefined) return { ok: false, error: 'text-emoji-or-clear-required', retryable: false }
  if (!clear && text && text.length > MAX_STATUS_LENGTH) return { ok: false, error: `text-too-long-max-${MAX_STATUS_LENGTH}`, retryable: false }
  if (expiresInMinutes !== undefined && (!Number.isFinite(expiresInMinutes) || expiresInMinutes <= 0)) {
    return { ok: false, error: 'expiresInMinutes-must-be-positive', retryable: false }
  }
  const profile = clear
    ? { status_text: '', status_emoji: '', status_expiration: 0 }
    : {
        status_text: text ?? '',
        status_emoji: emojiName(emoji),
        status_expiration: expiresInMinutes ? Math.floor(now / 1000) + Math.floor(expiresInMinutes * 60) : 0,
      }
  const body = { profile: JSON.stringify(profile) }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'users.profile.set', body: { profile } } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('users.profile.set', token, body)
}

export async function setPresence({ token, presence, dryRun, slackCall = callSlack }) {
  if (!['auto', 'away'].includes(presence)) return { ok: false, error: 'presence-must-be-auto-or-away', retryable: false }
  const body = { presence }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'users.setPresence', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('users.setPresence', token, body)
}

export async function manageDnd({ token, action, minutes, userId, dryRun, slackCall = callSlack }) {
  if (!['snooze', 'end', 'info'].includes(action)) return { ok: false, error: 'action-must-be-snooze-end-or-info', retryable: false }
  if (action === 'info') {
    if (!token) return { ok: false, error: 'no-token', retryable: false }
    return slackCall('dnd.info', token, userId ? { user: userId } : {})
  }
  if (action === 'snooze') {
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_SNOOZE_MINUTES) {
      return { ok: false, error: `minutes-must-be-between-1-and-${MAX_SNOOZE_MINUTES}`, retryable: false }
    }
    const body = { num_minutes: String(Math.floor(minutes)) }
    if (dryRun) return { ok: true, dryRun: true, request: { method: 'dnd.setSnooze', body } }
    if (!token) return { ok: false, error: 'no-token', retryable: false }
    return slackCall('dnd.setSnooze', token, body)
  }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'dnd.endSnooze', body: {} } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('dnd.endSnooze', token, {})
}
