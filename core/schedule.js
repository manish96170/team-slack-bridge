// Scheduled posting (extension to PLAN §4.1, added 2026-09-09 on request).
// Slack's own API: chat.scheduleMessage / chat.deleteScheduledMessage /
// chat.scheduledMessages.list — same `chat:write` scope as an immediate
// post, no new permission to grant. Same shape as core/post.js: tokens as
// parameters, structured { ok:false, error, retryable } failures, --dry-run
// support.

import { callSlack } from './slack.js'

// Slack requires post_at to be a Unix timestamp at least ~10s in the future
// and no more than 120 days out. Accept either an ISO string or a raw
// number of Unix seconds, since a caller may already have one or the other.
function toUnixSeconds(postAt) {
  if (typeof postAt === 'number') return Math.floor(postAt)
  const parsed = new Date(postAt)
  if (Number.isNaN(parsed.getTime())) return null
  return Math.floor(parsed.getTime() / 1000)
}

const MIN_LEAD_SECONDS = 10
const MAX_LEAD_SECONDS = 120 * 24 * 60 * 60

export async function scheduleMessage({ token, channel, text, blocks, threadTs, postAt, dryRun }) {
  if (!channel) return { ok: false, error: 'channel-required', retryable: false }
  if (!text && !blocks) return { ok: false, error: 'text-or-blocks-required', retryable: false }
  if (!postAt) return { ok: false, error: 'postAt-required', retryable: false }

  const postAtSeconds = toUnixSeconds(postAt)
  if (postAtSeconds === null) return { ok: false, error: 'invalid-postAt', retryable: false }

  const nowSeconds = Math.floor(Date.now() / 1000)
  if (postAtSeconds < nowSeconds + MIN_LEAD_SECONDS) {
    return { ok: false, error: 'postAt-must-be-at-least-10-seconds-in-the-future', retryable: false }
  }
  if (postAtSeconds > nowSeconds + MAX_LEAD_SECONDS) {
    return { ok: false, error: 'postAt-too-far-in-the-future-max-120-days', retryable: false }
  }

  const body = { channel, text, blocks, thread_ts: threadTs, post_at: postAtSeconds }

  if (dryRun) return { ok: true, dryRun: true, request: { method: 'chat.scheduleMessage', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return callSlack('chat.scheduleMessage', token, body)
}

export async function deleteScheduledMessage({ token, channel, scheduledMessageId, dryRun }) {
  if (!channel || !scheduledMessageId) return { ok: false, error: 'channel-and-scheduledMessageId-required', retryable: false }
  const body = { channel, scheduled_message_id: scheduledMessageId }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'chat.deleteScheduledMessage', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return callSlack('chat.deleteScheduledMessage', token, body)
}

export async function listScheduledMessages({ token, channel, limit = 20 }) {
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  const params = { limit: String(limit) }
  if (channel) params.channel = channel
  return callSlack('chat.scheduledMessages.list', token, params, { form: true })
}
