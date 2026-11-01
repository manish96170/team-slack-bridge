// Reminders (D72). reminders.* only works with a USER token (Slack does not
// let a bot own a reminder), so this is the authorized human's own reminder
// list. A reminder for someone ELSE shows up in their Slackbot DM under the
// requester's name, so that path needs an explicit confirm:true.
//
// `time` accepts what Slack accepts — a Unix timestamp, or natural language
// ("in 15 minutes", "tomorrow at 9am") — plus an ISO 8601 date/time, which is
// converted here so a caller never has to do the arithmetic.

import { callSlack } from './slack.js'

const MAX_LEAD_SECONDS = 365 * 24 * 60 * 60

// Returns { value } to send to Slack, or { error }. Bare numbers under 1e9
// are "seconds from now" (Slack's own convention, but only up to 24h, so it
// is converted to an absolute timestamp to lift that limit).
export function normalizeReminderTime(time, now = Date.now()) {
  const nowSeconds = Math.floor(now / 1000)
  if (typeof time === 'number') {
    if (!Number.isFinite(time) || time <= 0) return { error: 'invalid-time' }
    const absolute = time >= 1e9 ? Math.floor(time) : nowSeconds + Math.floor(time)
    return checkWindow(absolute, nowSeconds)
  }
  if (typeof time !== 'string' || !time.trim()) return { error: 'time-required' }
  const trimmed = time.trim()
  // A digits-only string is a number that happened to arrive as text (JSON callers do this): same rules as a number.
  if (/^\d+$/.test(trimmed)) return normalizeReminderTime(Number(trimmed), now)
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const parsed = Date.parse(trimmed)
    if (Number.isNaN(parsed)) return { error: 'invalid-time' }
    return checkWindow(Math.floor(parsed / 1000), nowSeconds)
  }
  return { value: trimmed, natural: true }
}

function checkWindow(absolute, nowSeconds) {
  if (absolute <= nowSeconds) return { error: 'time-must-be-in-the-future' }
  if (absolute > nowSeconds + MAX_LEAD_SECONDS) return { error: 'time-too-far-in-the-future-max-365-days' }
  return { value: absolute }
}

export async function addReminder({ token, text, time, userId, confirm, dryRun, now, slackCall = callSlack }) {
  if (!text) return { ok: false, error: 'text-required', retryable: false }
  const normalized = normalizeReminderTime(time, now)
  if (normalized.error) return { ok: false, error: normalized.error, retryable: false }
  const body = { text, time: normalized.value, ...(userId && { user: userId }) }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'reminders.add', body } }
  if (userId && confirm !== true) {
    return { ok: false, error: 'confirm-required-to-remind-another-user', retryable: false, userId, text }
  }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('reminders.add', token, body)
}

export async function listReminders({ token, slackCall = callSlack }) {
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('reminders.list', token, {})
}

export async function completeReminder({ token, reminderId, dryRun, slackCall = callSlack }) {
  if (!reminderId) return { ok: false, error: 'reminderId-required', retryable: false }
  const body = { reminder: reminderId }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'reminders.complete', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('reminders.complete', token, body)
}

export async function deleteReminder({ token, reminderId, dryRun, slackCall = callSlack }) {
  if (!reminderId) return { ok: false, error: 'reminderId-required', retryable: false }
  const body = { reminder: reminderId }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'reminders.delete', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('reminders.delete', token, body)
}
