// Channel/thread read helpers (PLAN §4.3). User-token search lives in
// core/search.js so the remote registry can import this file without also
// loading the search implementation.

import { callSlack } from './slack.js'

export async function queryMessages({ token, channel, sinceMinutes, oldest, limit = 20 }) {
  if (!channel) return { ok: false, error: 'channel-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  const params = { channel, limit: String(limit) }
  if (oldest) params.oldest = String(oldest)
  else if (sinceMinutes) params.oldest = String(Math.floor(Date.now() / 1000 - sinceMinutes * 60))
  return callSlack('conversations.history', token, params)
}

export async function getThread({ token, channel, threadTs }) {
  if (!channel || !threadTs) return { ok: false, error: 'channel-and-threadTs-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return callSlack('conversations.replies', token, { channel, ts: threadTs })
}
