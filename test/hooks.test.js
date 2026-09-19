import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from '../core/db.js'
import { recordAnswer } from '../core/ask.js'
import { setAway } from '../core/away.js'
import { preToolUse, preCompact, stop, notification } from '../core/hooks.js'

function tempDbPath() {
  return join(mkdtempSync(join(tmpdir(), 'hooks-test-')), 'db.sqlite')
}

async function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-home-'))
  const original = process.env.TSB_HOME
  process.env.TSB_HOME = dir
  try {
    return await fn(dir)
  } finally {
    if (original === undefined) delete process.env.TSB_HOME
    else process.env.TSB_HOME = original
    rmSync(dir, { recursive: true, force: true })
  }
}

function mockSlack(capture) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body))
    capture.push(body)
    const method = String(url).split('/').pop()
    let response
    if (method === 'conversations.open') {
      response = { ok: true, channel: { id: 'D_MOCK' } }
    } else {
      response = { ok: true, channel: body.channel, ts: '100.001', message: {} }
    }
    return {
      status: 200,
      headers: new Headers(),
      url: url.toString(),
      text: async () => JSON.stringify(response),
    }
  }
  return () => { globalThis.fetch = originalFetch }
}

// Polls the db until a pending ask appears, then answers it.
async function answerNextPendingAsk(dbPath, answer, { maxWaitMs = 3000, pollMs = 50 } = {}) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const db = getDb(dbPath)
    const pending = db.prepare("SELECT id FROM asks WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1").get()
    if (pending) {
      recordAnswer(dbPath, pending.id, answer)
      return pending.id
    }
    await new Promise(r => setTimeout(r, pollMs))
  }
  throw new Error('timed out waiting for a pending ask to appear')
}

const baseConfig = { owner: { slackUserId: 'U_OWNER' }, awayMode: { hookTimeoutSeconds: 10, gatedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit'] } }
let tokenCounter = 0
function freshEnv() { return { SLACK_BOT_TOKEN: `xoxb-hooks-test-${++tokenCounter}` } }

// --- Away-off tests ---

test('preToolUse skips when away mode is off', async () => {
  await withTempHome(async () => {
    setAway(false)
    const result = await preToolUse({ tool_name: 'Bash' }, { env: freshEnv(), config: baseConfig, dbPath: tempDbPath() })
    assert.equal(result.verdict, 'skip')
  })
})

test('preCompact skips when away mode is off', async () => {
  await withTempHome(async () => {
    setAway(false)
    const result = await preCompact({ trigger: 'auto' }, { env: freshEnv(), config: baseConfig, dbPath: tempDbPath() })
    assert.equal(result.verdict, 'skip')
  })
})

test('stop skips when away mode is off', async () => {
  await withTempHome(async () => {
    setAway(false)
    const result = await stop({ session_id: 's1' }, { env: freshEnv(), config: baseConfig, dbPath: tempDbPath() })
    assert.equal(result.verdict, 'skip')
  })
})

// --- preToolUse with seeded answers ---

test('preToolUse returns allow when the ask is answered with Approve', async () => {
  await withTempHome(async () => {
    setAway(true)
    const dbPath = tempDbPath()
    const posted = []
    const restore = mockSlack(posted)
    try {
      const askPromise = preToolUse(
        { tool_name: 'Bash', tool_input: 'ls -la' },
        { env: freshEnv(), config: baseConfig, dbPath, skipDaemonCheck: true }
      )
      await answerNextPendingAsk(dbPath, { kind: 'approval', label: 'Approve' })
      const result = await askPromise
      assert.equal(result.verdict, 'allow')
      assert.ok(result.reason.includes('Approved'))
    } finally {
      restore()
    }
  })
})

test('preToolUse returns deny when the ask is answered with Deny', async () => {
  await withTempHome(async () => {
    setAway(true)
    const dbPath = tempDbPath()
    const posted = []
    const restore = mockSlack(posted)
    try {
      const askPromise = preToolUse(
        { tool_name: 'Write', tool_input: '/tmp/x' },
        { env: freshEnv(), config: baseConfig, dbPath, skipDaemonCheck: true }
      )
      await answerNextPendingAsk(dbPath, { kind: 'approval', label: 'Deny' })
      const result = await askPromise
      assert.equal(result.verdict, 'deny')
    } finally {
      restore()
    }
  })
})

test('preToolUse returns defer on timeout for Claude (adapter emits no JSON, exit 0)', async () => {
  await withTempHome(async () => {
    setAway(true)
    const dbPath = tempDbPath()
    const posted = []
    const restore = mockSlack(posted)
    try {
      const result = await preToolUse(
        { tool_name: 'Bash' },
        { env: freshEnv(), config: { ...baseConfig, awayMode: { ...baseConfig.awayMode, hookTimeoutSeconds: 1 } }, dbPath, skipDaemonCheck: true }
      )
      assert.equal(result.verdict, 'defer')
      assert.ok(result.reason, 'defer should carry a reason for the adapter to surface')
    } finally {
      restore()
    }
  })
})

// D39 — THE divergence test: same timeout, different verdicts per harness
test('preToolUse returns deny on timeout for OpenCode (cannot defer, must deny)', async () => {
  await withTempHome(async () => {
    setAway(true)
    const dbPath = tempDbPath()
    const posted = []
    const restore = mockSlack(posted)
    try {
      const result = await preToolUse(
        { tool_name: 'Bash' },
        { env: freshEnv(), config: { ...baseConfig, awayMode: { ...baseConfig.awayMode, hookTimeoutSeconds: 1 } }, dbPath, skipDaemonCheck: true, harness: 'opencode' }
      )
      assert.equal(result.verdict, 'deny', 'OpenCode cannot defer — timeout must hard-deny')
      assert.ok(result.reason.includes('timeout'), 'reason should mention it was a timeout, not a policy denial')
    } finally {
      restore()
    }
  })
})

test('preToolUse skips ungated tools even when away', async () => {
  await withTempHome(async () => {
    setAway(true)
    const result = await preToolUse(
      { tool_name: 'Read' },
      { env: freshEnv(), config: baseConfig, dbPath: tempDbPath(), skipDaemonCheck: true }
    )
    assert.equal(result.verdict, 'skip')
  })
})

// --- preCompact ---

test('preCompact sends a notification DM (observational only, no blocking mechanism)', async () => {
  await withTempHome(async () => {
    setAway(true)
    const dbPath = tempDbPath()
    const posted = []
    const restore = mockSlack(posted)
    try {
      const result = await preCompact(
        { trigger: 'auto' },
        { env: freshEnv(), config: baseConfig, dbPath }
      )
      assert.equal(result.verdict, 'ok')
      assert.ok(posted.some(p => p.text?.includes('compaction')))
    } finally {
      restore()
    }
  })
})

test('preCompact skips non-auto triggers', async () => {
  await withTempHome(async () => {
    setAway(true)
    const result = await preCompact({ trigger: 'manual' }, { env: freshEnv(), config: baseConfig, dbPath: tempDbPath() })
    assert.equal(result.verdict, 'skip')
  })
})

// --- stop ---

test('stop returns allow when user replies done', async () => {
  await withTempHome(async () => {
    setAway(true)
    const dbPath = tempDbPath()
    const posted = []
    const restore = mockSlack(posted)
    try {
      const askPromise = stop(
        { session_id: 'test-session' },
        { env: freshEnv(), config: baseConfig, dbPath, skipDaemonCheck: true }
      )
      await answerNextPendingAsk(dbPath, { kind: 'question', text: 'done' })
      const result = await askPromise
      assert.equal(result.verdict, 'allow')
    } finally {
      restore()
    }
  })
})

test('stop returns block when user sends an instruction', async () => {
  await withTempHome(async () => {
    setAway(true)
    const dbPath = tempDbPath()
    const posted = []
    const restore = mockSlack(posted)
    try {
      const askPromise = stop(
        { session_id: 'test-session-2' },
        { env: freshEnv(), config: baseConfig, dbPath, skipDaemonCheck: true }
      )
      await answerNextPendingAsk(dbPath, { kind: 'question', text: 'fix the remaining test' })
      const result = await askPromise
      assert.equal(result.verdict, 'block')
      assert.ok(result.reason.includes('fix the remaining test'))
    } finally {
      restore()
    }
  })
})

// --- notification ---

test('notification sends a DM when away and returns ok', async () => {
  await withTempHome(async () => {
    setAway(true)
    const dbPath = tempDbPath()
    const posted = []
    const restore = mockSlack(posted)
    try {
      const result = await notification(
        { notification_type: 'idle_prompt', message: 'Agent is idle.' },
        { env: freshEnv(), config: baseConfig, dbPath, skipDaemonCheck: true }
      )
      assert.equal(result.verdict, 'ok')
      assert.ok(posted.some(p => p.text?.includes('idle_prompt')), `expected idle_prompt in posted texts: ${JSON.stringify(posted.map(p => p.text))}`)
    } finally {
      restore()
    }
  })
})

test('notification skips when not away', async () => {
  await withTempHome(async () => {
    setAway(false)
    const result = await notification(
      { notification_type: 'idle_prompt', message: 'hi' },
      { env: freshEnv(), config: baseConfig, dbPath: tempDbPath() }
    )
    assert.equal(result.verdict, 'skip')
  })
})

// --- preflight checks ---

test('preToolUse skips when no owner is configured (no Slack call attempted)', async () => {
  await withTempHome(async () => {
    setAway(true)
    const posted = []
    const restore = mockSlack(posted)
    try {
      const result = await preToolUse({ tool_name: 'Bash' }, { env: freshEnv(), config: {}, dbPath: tempDbPath(), skipDaemonCheck: true })
      assert.equal(result.verdict, 'skip')
      assert.equal(posted.length, 0)
    } finally {
      restore()
    }
  })
})
