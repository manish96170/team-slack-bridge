// The "AI companion" human-in-the-loop primitive (added 2026-09-09 on
// request): a running Claude Code / OpenCode session that hits a decision
// point — a permission gate, an ambiguous choice — asks the question as a
// Slack DM to the session's owner, and the session blocks until answered.
//
// Two capture paths, by decision:
// - **Approve/Deny buttons** (`kind: 'approval'`) can ONLY be captured by
//   the Socket Mode listener (listen/socket.js's `app.action` handler) —
//   Slack delivers a button click as a `block_actions` interactivity
//   event, never as a readable message, so there is no way to poll for it
//   directly against the Slack API. The listener must be running.
// - **Free-text replies** (`kind: 'question'`) can be captured either way:
//   by the listener (event-driven, the default — see D9), or by directly
//   polling `conversations.replies` on the DM thread if no listener is
//   running (`captureMode: 'poll'`, opt-in, togglable — this only ever
//   applies to `question`, never `approval`).
//
// The correlation problem — the process that asks (a short-lived MCP tool
// call) is very often not the process that captures the answer (the
// long-lived listener) — is solved with the same tool already added for
// ledger concurrency: a local SQLite table (core/db.js) both processes
// share. `waitForAnswer` polls that LOCAL table, not Slack, so it's fast
// and free of Slack rate limits regardless of which capture path fed it.

import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'
import { resolveDmChannel } from './dm.js'
import { callSlack } from './slack.js'
import { getThread } from './query.js'

function buildApprovalBlocks(askId, question, options) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: question } },
    {
      type: 'actions',
      block_id: `ask:${askId}`,
      elements: options.map(label => ({
        type: 'button',
        text: { type: 'plain_text', text: label, emoji: true },
        action_id: `ask_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
        value: `${askId}:${label}`,
      })),
    },
  ]
}

// Posts the question and records a `pending` row. Does not wait — call
// `waitForAnswer` (or the `ask()` convenience wrapper) for that.
//
// `channel`+`threadTs` (both required together) target an EXISTING thread
// instead of DM'ing — used by ACP session permission requests, which must
// render in the session's own thread, not a DM (PLAN: ACP thread sessions).
// Correlation for a thread-target ask uses the GIVEN threadTs (the thread's
// root), not this reply's own ts, since later replies in that thread carry
// the root's thread_ts, not this message's.
export async function createAsk({ botToken, userId, question, kind = 'question', options = ['Approve', 'Deny'], dbPath, channel: targetChannel, threadTs: targetThreadTs }) {
  if (!botToken) return { ok: false, error: 'no-token', retryable: false }
  if (!userId || !question) return { ok: false, error: 'userId-and-question-required', retryable: false }
  if (kind !== 'question' && kind !== 'approval') return { ok: false, error: 'kind-must-be-question-or-approval', retryable: false }
  if (!dbPath) return { ok: false, error: 'db-path-required', retryable: false }
  if ((targetChannel && !targetThreadTs) || (!targetChannel && targetThreadTs)) {
    return { ok: false, error: 'channel-and-threadTs-required-together', retryable: false }
  }

  const askId = randomUUID()
  const db = getDb(dbPath)
  db.prepare('INSERT INTO asks (id, user_id, question, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    askId,
    userId,
    question,
    kind,
    'pending',
    new Date().toISOString()
  )

  let channel = targetChannel
  if (!channel) {
    const opened = await resolveDmChannel({ token: botToken, userId, dbPath })
    if (!opened.ok) {
      db.prepare("UPDATE asks SET status = 'failed', answer = ?, answered_at = ? WHERE id = ?").run(
        JSON.stringify({ error: opened.error }),
        new Date().toISOString(),
        askId
      )
      return opened
    }
    channel = opened.channel.id
  }

  const body = {
    channel,
    text: question,
    ...(kind === 'approval' ? { blocks: buildApprovalBlocks(askId, question, options) } : {}),
    ...(targetThreadTs ? { thread_ts: targetThreadTs } : {}),
  }

  const posted = await callSlack('chat.postMessage', botToken, body)
  if (!posted.ok) {
    db.prepare("UPDATE asks SET status = 'failed', channel = ?, answer = ?, answered_at = ? WHERE id = ?").run(
      channel,
      JSON.stringify({ error: posted.error }),
      new Date().toISOString(),
      askId
    )
    return posted
  }

  const threadTs = targetThreadTs || posted.ts
  db.prepare('UPDATE asks SET channel = ?, thread_ts = ? WHERE id = ?').run(channel, threadTs, askId)

  return { ok: true, askId, channel, threadTs }
}

function rowToAsk(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    question: row.question,
    kind: row.kind,
    channel: row.channel,
    threadTs: row.thread_ts,
    status: row.status,
    answer: row.answer ? JSON.parse(row.answer) : undefined,
    createdAt: row.created_at,
    answeredAt: row.answered_at ?? undefined,
  }
}

export function getAsk(dbPath, askId) {
  const db = getDb(dbPath)
  return rowToAsk(db.prepare('SELECT * FROM asks WHERE id = ?').get(askId))
}

// Called by the listener (listen/socket.js) when a button click or a
// free-text reply arrives. Idempotent-ish: only ever writes a `pending`
// row, so a redelivered event finds nothing left to update.
export function recordAnswer(dbPath, askId, answer) {
  const db = getDb(dbPath)
  const result = db
    .prepare("UPDATE asks SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = 'pending'")
    .run(JSON.stringify(answer), new Date().toISOString(), askId)
  return result.changes > 0
}

// Free-text replies don't carry the askId the way a button's `value` does
// — they're just a message in the DM thread — so this looks the pending
// ask up by (channel, thread_ts) instead.
// `kind = 'question'` only — this is the free-text capture path, and this
// header's own design says approval buttons can ONLY be captured by the
// block_actions handler. Found in review: without this filter, a plain
// message arriving while an approval is pending got packaged as a
// {kind:'question'} answer anyway, which core/ask.js's caller then finds no
// matching button label for and treats as a cancellation — silently
// denying the pending approval instead of doing nothing.
export function recordAnswerByThread(dbPath, channel, threadTs, answer) {
  const db = getDb(dbPath)
  const row = db.prepare("SELECT id FROM asks WHERE channel = ? AND thread_ts = ? AND status = 'pending' AND kind = 'question'").get(channel, threadTs)
  if (!row) return false
  return recordAnswer(dbPath, row.id, answer)
}

// Polls the LOCAL asks table (not Slack) until the listener (or the direct
// poll below) has recorded an answer, or the timeout elapses.
export async function waitForAnswer({ dbPath, askId, timeoutSeconds = 300, pollIntervalMs = 1000 }) {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    const found = getAsk(dbPath, askId)
    if (!found) return { ok: false, error: 'ask-not-found', retryable: false }
    if (found.status === 'answered') return { ok: true, askId, answer: found.answer }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  const db = getDb(dbPath)
  db.prepare("UPDATE asks SET status = 'timeout' WHERE id = ? AND status = 'pending'").run(askId)
  return { ok: false, error: 'timeout', retryable: true }
}

// Direct-poll fallback for `question`-kind asks only (§ header comment —
// buttons are never visible this way). Polls Slack itself instead of
// relying on the listener; only meaningful when captureMode is 'poll'.
export async function pollThreadForReply({ token, channel, threadTs, timeoutSeconds = 300, pollIntervalMs = 3000 }) {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    const thread = await getThread({ token, channel, threadTs })
    if (thread.ok) {
      const reply = thread.messages?.find(m => m.ts !== threadTs)
      if (reply) return { ok: true, answer: { kind: 'question', text: reply.text, user: reply.user } }
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  return { ok: false, error: 'timeout', retryable: true }
}

// The convenience wrapper an MCP tool / CLI command actually calls.
export async function ask({ botToken, userId, question, kind = 'question', options, dbPath, timeoutSeconds = 300, captureMode = 'listener', channel, threadTs }) {
  if (captureMode === 'poll' && kind === 'approval') {
    return { ok: false, error: 'approval-buttons-require-the-listener-not-pollable', retryable: false }
  }

  const created = await createAsk({ botToken, userId, question, kind, options, dbPath, channel, threadTs })
  if (!created.ok) return created

  if (captureMode === 'poll') {
    return pollThreadForReply({ token: botToken, channel: created.channel, threadTs: created.threadTs, timeoutSeconds })
  }
  return waitForAnswer({ dbPath, askId: created.askId, timeoutSeconds })
}
