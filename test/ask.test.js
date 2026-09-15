import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from '../core/db.js'
import { recordAnswer, recordAnswerByThread, getAsk, waitForAnswer, ask, createAsk } from '../core/ask.js'

// @slack/web-api's WebClient sends form-urlencoded bodies, not JSON.
function parseFormBody(body) {
  return Object.fromEntries(new URLSearchParams(body))
}

function mockChatPostMessage(capture) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = parseFormBody(init.body)
    capture.push(body)
    return {
      status: 200,
      headers: new Headers(),
      url: url.toString(),
      text: async () => JSON.stringify({ ok: true, channel: body.channel, ts: '100.001', message: {} }),
    }
  }
  return () => {
    globalThis.fetch = originalFetch
  }
}

function tempDbPath() {
  return join(mkdtempSync(join(tmpdir(), 'ask-test-')), 'db.sqlite')
}

function insertPendingAsk(dbPath, { id, userId = 'U1', question = 'q?', kind = 'question', channel = 'D1', threadTs = '1.1' }) {
  const db = getDb(dbPath)
  db.prepare('INSERT INTO asks (id, user_id, question, kind, channel, thread_ts, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    userId,
    question,
    kind,
    channel,
    threadTs,
    'pending',
    new Date().toISOString()
  )
}

test('recordAnswer marks a pending ask answered and stores the answer', () => {
  const dbPath = tempDbPath()
  insertPendingAsk(dbPath, { id: 'ask-1' })
  const changed = recordAnswer(dbPath, 'ask-1', { kind: 'approval', label: 'Approve' })
  assert.equal(changed, true)
  const found = getAsk(dbPath, 'ask-1')
  assert.equal(found.status, 'answered')
  assert.deepEqual(found.answer, { kind: 'approval', label: 'Approve' })
})

test('recordAnswer on an already-answered ask is a no-op (redelivery-safe)', () => {
  const dbPath = tempDbPath()
  insertPendingAsk(dbPath, { id: 'ask-2' })
  assert.equal(recordAnswer(dbPath, 'ask-2', { kind: 'approval', label: 'Approve' }), true)
  assert.equal(recordAnswer(dbPath, 'ask-2', { kind: 'approval', label: 'Deny' }), false)
  assert.equal(getAsk(dbPath, 'ask-2').answer.label, 'Approve')
})

test('recordAnswerByThread finds the pending ask by channel+thread_ts, not by id', () => {
  const dbPath = tempDbPath()
  insertPendingAsk(dbPath, { id: 'ask-3', channel: 'D9', threadTs: '9.9' })
  const captured = recordAnswerByThread(dbPath, 'D9', '9.9', { kind: 'question', text: 'yes' })
  assert.equal(captured, true)
  assert.equal(getAsk(dbPath, 'ask-3').answer.text, 'yes')
})

test('recordAnswerByThread on an unrelated thread finds nothing', () => {
  const dbPath = tempDbPath()
  insertPendingAsk(dbPath, { id: 'ask-4', channel: 'D9', threadTs: '9.9' })
  assert.equal(recordAnswerByThread(dbPath, 'D9', '0.0', { kind: 'question', text: 'yes' }), false)
})

test('waitForAnswer resolves once the answer lands, without the caller needing to know how it got there', async () => {
  const dbPath = tempDbPath()
  insertPendingAsk(dbPath, { id: 'ask-5' })
  setTimeout(() => recordAnswer(dbPath, 'ask-5', { kind: 'question', text: 'ok' }), 30)
  const result = await waitForAnswer({ dbPath, askId: 'ask-5', timeoutSeconds: 5, pollIntervalMs: 10 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.answer, { kind: 'question', text: 'ok' })
})

test('waitForAnswer times out and marks the ask timeout rather than hanging forever', async () => {
  const dbPath = tempDbPath()
  insertPendingAsk(dbPath, { id: 'ask-6' })
  const result = await waitForAnswer({ dbPath, askId: 'ask-6', timeoutSeconds: 0.05, pollIntervalMs: 10 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'timeout')
  assert.equal(getAsk(dbPath, 'ask-6').status, 'timeout')
})

test('waitForAnswer on an unknown askId fails structured, not thrown', async () => {
  const dbPath = tempDbPath()
  const result = await waitForAnswer({ dbPath, askId: 'no-such-ask', timeoutSeconds: 0.05, pollIntervalMs: 10 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'ask-not-found')
})

test('ask() refuses kind:approval with captureMode:poll before ever calling Slack', async () => {
  const dbPath = tempDbPath()
  const result = await ask({ userId: 'U1', question: 'deploy?', kind: 'approval', captureMode: 'poll', dbPath })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'approval-buttons-require-the-listener-not-pollable')
})

test('ask() without a bot token fails structured before touching the DB', async () => {
  const dbPath = tempDbPath()
  const result = await ask({ userId: 'U1', question: 'deploy?', dbPath })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-token')
})

test('createAsk with {channel, threadTs} posts into that thread instead of a DM, and correlates on the given threadTs', async () => {
  const dbPath = tempDbPath()
  const posted = []
  const restore = mockChatPostMessage(posted)
  try {
    const result = await createAsk({
      botToken: 'xoxb-test',
      userId: 'U1',
      question: 'ok to deploy?',
      kind: 'approval',
      dbPath,
      channel: 'C123',
      threadTs: '111.111',
    })
    assert.equal(result.ok, true)
    assert.equal(result.channel, 'C123')
    // Correlates on the GIVEN thread root, not this reply's own ts — later
    // replies in that thread carry the root's thread_ts, not this message's.
    assert.equal(result.threadTs, '111.111')
    assert.equal(posted[0].channel, 'C123')
    assert.equal(posted[0].thread_ts, '111.111')
    assert.equal(getAsk(dbPath, result.askId).threadTs, '111.111')
  } finally {
    restore()
  }
})

test('createAsk without a thread target still DMs, unchanged from before this feature', async () => {
  const dbPath = tempDbPath()
  const posted = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (url.toString().includes('conversations.open')) {
      return { status: 200, headers: new Headers(), url: url.toString(), text: async () => JSON.stringify({ ok: true, channel: { id: 'D999' } }) }
    }
    const body = parseFormBody(init.body)
    posted.push(body)
    return { status: 200, headers: new Headers(), url: url.toString(), text: async () => JSON.stringify({ ok: true, channel: body.channel, ts: '200.002' }) }
  }
  try {
    const result = await createAsk({ botToken: 'xoxb-test-dm', userId: 'U1', question: 'hi', dbPath })
    assert.equal(result.ok, true)
    assert.equal(result.channel, 'D999')
    assert.equal(result.threadTs, '200.002')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('createAsk rejects channel without threadTs (and vice versa) rather than guessing', async () => {
  const dbPath = tempDbPath()
  const result = await createAsk({ botToken: 'xoxb-test', userId: 'U1', question: 'hi', dbPath, channel: 'C1' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'channel-and-threadTs-required-together')
})
