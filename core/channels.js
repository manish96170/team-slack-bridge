// "Which channels am I in" (PLAN D41, §13). Deliberately `users.conversations`,
// never `conversations.list` — the latter enumerates every channel in the
// workspace regardless of the caller's membership, which is a
// directory-enumeration primitive (the same shape D20 already refused for
// unrestricted `resolveUser`). `users.conversations` can only ever return
// what the token's own user could already see in their own Slack sidebar,
// so this needs a user token and nothing else gates it further.

import { callSlack } from './slack.js'

export async function listMyChannels({ token, types, limit = 100, cursor }) {
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  const params = {
    types: types || 'public_channel,private_channel',
    exclude_archived: 'true',
    limit: String(limit),
  }
  if (cursor) params.cursor = cursor
  return callSlack('users.conversations', token, params)
}
