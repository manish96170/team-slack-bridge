// Reading reactions (D73). slack_react / slack_unreact (core/post.js) can add
// and remove a reaction; this is the read side, needing reactions:read on
// whichever token is used (user and bot both).
//
//   reactions.get  — who reacted with what on ONE message
//   reactions.list — the messages a user has reacted to (the token's own user
//                    unless `userId` is given)
//
// Read-only. Token selection and the echoed `tokenSource` live in the tool
// layer (mcp/tools.features.js), same as the other D72 read tools.

import { callSlack } from './slack.js'

const SNIPPET_CHARS = 200
const DEFAULT_COUNT = 20
const MAX_COUNT = 100

function normalizeReactions(reactions, emoji) {
  const wanted = emoji ? String(emoji).trim().replace(/^:+|:+$/g, '').toLowerCase() : undefined
  return (reactions || [])
    .filter(reaction => !wanted || reaction.name?.toLowerCase().split('::')[0] === wanted)
    .map(reaction => ({ name: reaction.name, count: reaction.count, users: reaction.users || [] }))
}

export async function getReactions({ token, channel, ts, emoji, slackCall = callSlack }) {
  if (!channel || !ts) return { ok: false, error: 'channel-and-ts-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  const result = await slackCall('reactions.get', token, { channel, timestamp: ts, full: 'true' })
  if (!result.ok) return result
  const message = result.message || {}
  return {
    ok: true,
    channel: result.channel || channel,
    ts: message.ts || ts,
    reactions: normalizeReactions(message.reactions, emoji),
  }
}

export async function listReactions({ token, userId, count = DEFAULT_COUNT, cursor, emoji, slackCall = callSlack }) {
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  const params = { full: 'true', count: String(Math.min(Math.max(Math.floor(Number(count)) || DEFAULT_COUNT, 1), MAX_COUNT)) }
  if (userId) params.user = userId
  if (cursor) params.cursor = cursor
  const result = await slackCall('reactions.list', token, params)
  if (!result.ok) return result

  const items = (result.items || [])
    // Files and file comments carry reactions too; this tool reports messages.
    .filter(item => item.type === 'message' && item.message)
    .map(item => ({
      channel: item.channel,
      ts: item.message.ts,
      text: typeof item.message.text === 'string' ? item.message.text.slice(0, SNIPPET_CHARS) : undefined,
      reactions: normalizeReactions(item.message.reactions, emoji),
    }))
    .filter(item => !emoji || item.reactions.length)

  return { ok: true, items, nextCursor: result.response_metadata?.next_cursor || undefined }
}
