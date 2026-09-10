import { callSlack } from './slack.js'

export async function search({ userToken, query }) {
  if (!query) return { ok: false, error: 'query-required', retryable: false }
  if (!userToken) return { ok: false, error: 'search-requires-user-token', retryable: false }
  return callSlack('search.messages', userToken, { query })
}
