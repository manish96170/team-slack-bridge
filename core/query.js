// Query/read (PLAN §4.3). `search` is user-token-only by Slack's own
// construction, not a choice made here — and that's why it's absent from
// remote regardless of configuration (§11).

import { callSlack } from './slack.js'

export async function queryMessages({ token, channel, sinceMinutes, oldest, limit = 20 }) {
  if (!channel) return { ok: false, error: 'channel-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  const params = { channel, limit: String(limit) }
  if (oldest) params.oldest = String(oldest)
  else if (sinceMinutes) params.oldest = String(Math.floor(Date.now() / 1000 - sinceMinutes * 60))
  return callSlack('conversations.history', token, params, { form: true })
}

export async function getThread({ token, channel, threadTs }) {
  if (!channel || !threadTs) return { ok: false, error: 'channel-and-threadTs-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return callSlack('conversations.replies', token, { channel, ts: threadTs }, { form: true })
}

export async function search({ userToken, query }) {
  if (!query) return { ok: false, error: 'query-required', retryable: false }
  if (!userToken) return { ok: false, error: 'search-requires-user-token', retryable: false }
  return callSlack('search.messages', userToken, { query }, { form: true })
}
