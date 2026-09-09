// DM sending (PLAN §4.1/§4.2). Local-only capability by decision (§11) —
// absent from the remote tool registry's import graph.

import { callSlack } from './slack.js'
import { resolveMentions } from './identity.js'

export async function resolveDmChannel({ token, userId }) {
  return callSlack('conversations.open', token, { users: userId })
}

export async function dm({ botToken, userToken, userId, text, blocks, asUser, config, dryRun }) {
  if (!userId) return { ok: false, error: 'user-id-required', retryable: false }

  const token = asUser ? userToken : botToken
  const resolvedText = resolveMentions(text, config)
  if (dryRun) {
    return { ok: true, dryRun: true, request: { method: 'chat.postMessage', body: { text: resolvedText, blocks }, userId, asUser: !!asUser } }
  }
  if (!botToken) return { ok: false, error: 'bot-token-required-to-open-dm', retryable: false }
  if (!token) return { ok: false, error: asUser ? 'user-token-required' : 'bot-token-required', retryable: false }

  const opened = await resolveDmChannel({ token: botToken, userId })
  if (!opened.ok) return opened

  return callSlack('chat.postMessage', token, { channel: opened.channel.id, text: resolvedText, blocks })
}
