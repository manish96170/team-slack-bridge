// DM sending (PLAN §4.1/§4.2). Local-only capability by decision (§11) —
// absent from the remote tool registry's import graph.

import { createHash } from 'node:crypto'
import { callSlack } from './slack.js'
import { resolveMentions } from './identity.js'
import { getDb } from './db.js'

// A Slack DM is specific to the token identity that opened it. A bot↔recipient
// channel is not writable by a human user token (and vice versa), so callers
// must use distinct cache keys for bot and as-user conversations — and, since
// SLACK_BOT_TOKEN/SLACK_USER_TOKEN can themselves change (a rotated token, or
// a different human re-authorizing the same local install), the key must be
// specific to the TOKEN actually in use, not just "bot" vs "user" as a mode
// label. `tokenFingerprint` is a one-way, truncated hash — enough to bust the
// cache on a token change without ever storing or logging the token value
// itself (PLAN §7's "never a token value" rule, applied to a derived value too).
function tokenFingerprint(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 12)
}

export async function resolveDmChannel({ token, userId, cacheKey = userId, dbPath }) {
  if (dbPath) {
    const cached = getDb(dbPath).prepare('SELECT channel_id FROM dm_channels WHERE user_id = ?').get(cacheKey)
    if (cached?.channel_id) return { ok: true, cached: true, channel: { id: cached.channel_id } }
  }

  const opened = await callSlack('conversations.open', token, { users: userId })
  if (opened.ok && dbPath) {
    getDb(dbPath)
      .prepare(
        `INSERT INTO dm_channels (user_id, channel_id, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET channel_id = excluded.channel_id, updated_at = excluded.updated_at`
      )
      .run(cacheKey, opened.channel.id, new Date().toISOString())
  }
  return opened
}

export async function dm({ botToken, userToken, userId, text, blocks, asUser, config, dbPath, dryRun }) {
  if (!userId) return { ok: false, error: 'user-id-required', retryable: false }

  const token = asUser ? userToken : botToken
  const resolvedText = resolveMentions(text, config)
  if (dryRun) {
    return { ok: true, dryRun: true, request: { method: 'chat.postMessage', body: { text: resolvedText, blocks }, userId, asUser: !!asUser } }
  }
  if (!token) return { ok: false, error: asUser ? 'user-token-required' : 'bot-token-required', retryable: false }

  const opened = await resolveDmChannel({
    token,
    userId,
    cacheKey: `${asUser ? 'user' : 'bot'}:${tokenFingerprint(token)}:${userId}`,
    dbPath,
  })
  if (!opened.ok) return opened

  return callSlack('chat.postMessage', token, { channel: opened.channel.id, text: resolvedText, blocks })
}
