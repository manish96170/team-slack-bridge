// Outbound posting (PLAN §4.1). Plain functions, tokens as parameters
// (§0/D2) — the same code runs from the CLI, the MCP server, and the
// dashboard's in-process import.

import { callSlack } from './slack.js'
import { claim, complete, findByTs } from './ledger.js'
import { resolveMentions } from './identity.js'

export async function postToChannel({
  token,
  channel,
  text,
  blocks,
  threadTs,
  unfurlLinks,
  idempotencyKey,
  ledgerPath,
  config,
  dryRun,
}) {
  if (!channel) return { ok: false, error: 'channel-required', retryable: false }
  if (!text && !blocks) return { ok: false, error: 'text-or-blocks-required', retryable: false }

  const body = { channel, text: resolveMentions(text, config), blocks, thread_ts: threadTs, unfurl_links: unfurlLinks }

  if (dryRun) return { ok: true, dryRun: true, request: { method: 'chat.postMessage', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }

  if (idempotencyKey && ledgerPath) {
    const existing = claim(ledgerPath, idempotencyKey)
    if (existing) {
      if (existing.status === 'done') return { ok: true, ...existing.result, deduped: true }
      return { ok: false, error: 'idempotency-key-already-in-flight', retryable: false }
    }
  }

  const result = await callSlack('chat.postMessage', token, body)
  if (idempotencyKey && ledgerPath) {
    complete(ledgerPath, idempotencyKey, result.ok ? { channel: result.channel, ts: result.ts } : { failed: true })
  }
  return result
}

export function reply({ threadTs, ...rest }) {
  if (!threadTs) return Promise.resolve({ ok: false, error: 'threadTs-required', retryable: false })
  return postToChannel({ ...rest, threadTs })
}

export async function react({ token, channel, ts, emoji, dryRun }) {
  if (!channel || !ts || !emoji) return { ok: false, error: 'channel-ts-emoji-required', retryable: false }
  const body = { channel, timestamp: ts, name: emoji }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'reactions.add', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return callSlack('reactions.add', token, body)
}

// `requireLedgerOwnership` is the remote limit (§11.6 #2): refuse to touch a
// ts this instance's ledger did not itself record, so a shared bot token
// can't be used to edit/delete a message a different caller posted. Local
// defaults to false — a single-owner install has nothing else to protect
// against here, and Slack's own chat.update/chat.delete already refuse
// messages the calling token didn't post.
export async function updateMessage({ token, channel, ts, text, blocks, ledgerPath, config, requireLedgerOwnership = false, dryRun }) {
  if (!channel || !ts) return { ok: false, error: 'channel-ts-required', retryable: false }
  const body = { channel, ts, text: resolveMentions(text, config), blocks }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'chat.update', body } }
  if (requireLedgerOwnership) {
    if (!ledgerPath || !findByTs(ledgerPath, channel, ts)) return { ok: false, error: 'not-own-message', retryable: false }
  }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return callSlack('chat.update', token, body)
}

export async function deleteMessage({ token, channel, ts, ledgerPath, requireLedgerOwnership = false, dryRun }) {
  if (!channel || !ts) return { ok: false, error: 'channel-ts-required', retryable: false }
  const body = { channel, ts }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'chat.delete', body } }
  if (requireLedgerOwnership) {
    if (!ledgerPath || !findByTs(ledgerPath, channel, ts)) return { ok: false, error: 'not-own-message', retryable: false }
  }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return callSlack('chat.delete', token, body)
}
