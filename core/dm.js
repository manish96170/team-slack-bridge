// DM sending (PLAN §4.1/§4.2). Local-only capability by decision (§11) —
// absent from the remote tool registry's import graph.

import { callSlack } from './slack.js'
import { resolveMentions } from './identity.js'
import { getDb } from './db.js'

export async function resolveDmChannel({ token, userId, dbPath }) {
  if (dbPath) {
    const cached = getDb(dbPath).prepare('SELECT channel_id FROM dm_channels WHERE user_id = ?').get(userId)
    if (cached?.channel_id) return { ok: true, cached: true, channel: { id: cached.channel_id } }
  }

  const opened = await callSlack('conversations.open', token, { users: userId })
  if (opened.ok && dbPath) {
    getDb(dbPath)
      .prepare(
        `INSERT INTO dm_channels (user_id, channel_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET channel_id = excluded.channel_id, updated_at = excluded.updated_at`
      )
      .run(userId, opened.channel.id, new Date().toISOString())
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
  if (!botToken) return { ok: false, error: 'bot-token-required-to-open-dm', retryable: false }
  if (!token) return { ok: false, error: asUser ? 'user-token-required' : 'bot-token-required', retryable: false }

  const opened = await resolveDmChannel({ token: botToken, userId, dbPath })
  if (!opened.ok) return opened

  return callSlack('chat.postMessage', token, { channel: opened.channel.id, text: resolvedText, blocks })
}
