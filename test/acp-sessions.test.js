import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isAllowedToStartSession,
  isAllowedToCloseSession,
  isAllowedToUseRepo,
  matchesMentionKeyword,
  contextUsageRatio,
  parseContextFullCommand,
  parseRewindCount,
  parseRewindDetail,
  startAgentSession,
  routeThreadReply,
  closeAgentSession,
  parseAgentSessionCommand,
  applyModelSelection,
  runPromptTurn,
  withKeyLock,
} from '../core/acp-sessions.js'
import { createAgentSession, updateAgentSession, getAgentSession } from '../core/agent-sessions.js'

async function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-acp-sessions-'))
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

const baseConfig = { owner: { slackUserId: 'U_OWNER' }, agentSessions: { enabled: true, allowedUsers: ['U_ALLOWED'] } }

test('isAllowedToStartSession: the owner is always allowed', () => {
  assert.equal(isAllowedToStartSession(baseConfig, 'U_OWNER'), true)
})

test('isAllowedToStartSession: an explicitly allow-listed user is allowed', () => {
  assert.equal(isAllowedToStartSession(baseConfig, 'U_ALLOWED'), true)
})

test('isAllowedToStartSession: anyone else is rejected regardless of channel (PLAN D24)', () => {
  assert.equal(isAllowedToStartSession(baseConfig, 'U_RANDOM'), false)
})

test('isAllowedToStartSession: with no allowedUsers configured, only the owner is allowed', () => {
  assert.equal(isAllowedToStartSession({ owner: { slackUserId: 'U_OWNER' }, agentSessions: {} }, 'U_RANDOM'), false)
})

test('isAllowedToCloseSession: the owner may close anyone\'s session', () => {
  assert.equal(isAllowedToCloseSession(baseConfig, 'U_OWNER', 'U_ALLOWED'), true)
})

test('isAllowedToCloseSession: the session\'s own starter may close it, even if they are not in allowedUsers/allowedControllers at all', () => {
  assert.equal(isAllowedToCloseSession({ owner: { slackUserId: 'U_OWNER' }, agentSessions: {} }, 'U_STARTER', 'U_STARTER'), true)
})

test('isAllowedToCloseSession: being in allowedUsers (start rights) does NOT grant close rights over someone else\'s session (D31)', () => {
  assert.equal(isAllowedToCloseSession(baseConfig, 'U_ALLOWED', 'U_SOMEONE_ELSE'), false)
})

test('isAllowedToCloseSession: an explicitly listed controller may close a session they did not start', () => {
  const config = { owner: { slackUserId: 'U_OWNER' }, agentSessions: { allowedControllers: ['U_CONTROLLER'] } }
  assert.equal(isAllowedToCloseSession(config, 'U_CONTROLLER', 'U_SOMEONE_ELSE'), true)
})

test('isAllowedToUseRepo: the owner may use any repo regardless of repoAccess', () => {
  const config = { owner: { slackUserId: 'U_OWNER' }, agentSessions: { repoAccess: { U_OWNER: [] } } }
  assert.equal(isAllowedToUseRepo(config, 'U_OWNER', 'some-repo'), true)
})

test('isAllowedToUseRepo: a user with no repoAccess entry configured stays unrestricted (backward compatible)', () => {
  assert.equal(isAllowedToUseRepo(baseConfig, 'U_ALLOWED', 'any-repo-at-all'), true)
})

test('isAllowedToUseRepo: a user with a repoAccess entry is limited to the repos listed in it', () => {
  const config = { owner: { slackUserId: 'U_OWNER' }, agentSessions: { repoAccess: { U_ALLOWED: ['repo-a'] } } }
  assert.equal(isAllowedToUseRepo(config, 'U_ALLOWED', 'repo-a'), true)
  assert.equal(isAllowedToUseRepo(config, 'U_ALLOWED', 'repo-b'), false)
})

test('matchesMentionKeyword: falls back to the single mentionKeyword when no aliases are configured', () => {
  const config = { agentSessions: { mentionKeyword: 'start session' } }
  assert.equal(matchesMentionKeyword('start session fix the bug', config), ' fix the bug')
  assert.equal(matchesMentionKeyword('hello there', config), null)
})

test('matchesMentionKeyword: defaults to "start session" when nothing is configured at all', () => {
  assert.equal(matchesMentionKeyword('start session fix it', {}), ' fix it')
})

test('matchesMentionKeyword: matches any configured alias, case-insensitively', () => {
  const config = { agentSessions: { mentionKeywords: ['start session', '@etd start session', '@Eng Team Dashboard start session'] } }
  assert.equal(matchesMentionKeyword('@ETD START SESSION fix it', config), ' fix it')
  assert.equal(matchesMentionKeyword('@Eng Team Dashboard start session fix it', config), ' fix it')
  assert.equal(matchesMentionKeyword('start session fix it', config), ' fix it')
  assert.equal(matchesMentionKeyword('just chatting', config), null)
})

test('matchesMentionKeyword: a longer alias is not shadowed by a shorter one that prefixes it', () => {
  const config = { agentSessions: { mentionKeywords: ['start', 'start session please'] } }
  assert.equal(matchesMentionKeyword('start session please fix it', config), ' fix it')
})

test('contextUsageRatio: computes used/size, and is 0 for missing or zero-size usage', () => {
  assert.equal(contextUsageRatio({ used: 80, size: 100 }), 0.8)
  assert.equal(contextUsageRatio(undefined), 0)
  assert.equal(contextUsageRatio({ used: 5, size: 0 }), 0)
})

test('parseContextFullCommand: recognizes compact/here/new-thread, case-insensitively, nothing else', () => {
  assert.equal(parseContextFullCommand('compact please'), 'compact')
  assert.equal(parseContextFullCommand('Here'), 'here')
  assert.equal(parseContextFullCommand('new session, let\'s go'), 'here')
  assert.equal(parseContextFullCommand('New Thread'), 'new-thread')
  assert.equal(parseContextFullCommand('what is going on'), null)
})

test('parseRewindCount: accepts only integers 1-10', () => {
  assert.equal(parseRewindCount('5'), 5)
  assert.equal(parseRewindCount('0'), null)
  assert.equal(parseRewindCount('11'), null)
  assert.equal(parseRewindCount('abc'), null)
})

test('parseRewindDetail: recognizes the two detail-level replies', () => {
  assert.equal(parseRewindDetail('summary and code please'), 'code')
  assert.equal(parseRewindDetail('just summary'), 'summary')
  assert.equal(parseRewindDetail('huh'), null)
})

test('isAllowedToCloseSession: anyone else is refused', () => {
  assert.equal(isAllowedToCloseSession(baseConfig, 'U_RANDOM', 'U_SOMEONE_ELSE'), false)
})

test('startAgentSession rejects a non-allowed user before resolving a backend or repo, or spawning anything', async () => {
  const result = await startAgentSession({
    env: {},
    config: baseConfig,
    dbPath: '/tmp/should-never-be-touched.sqlite',
    channel: 'C1',
    threadTs: '1.1',
    backendName: 'claude',
    repoName: 'anything',
    task: 'do something',
    requestedBy: 'U_RANDOM',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'not-allowed-to-start-agent-session')
})

test('startAgentSession rejects an unknown backend name for an allowed user, before touching a repo or spawning anything', async () => {
  const result = await startAgentSession({
    env: {},
    config: baseConfig,
    dbPath: '/tmp/should-never-be-touched.sqlite',
    channel: 'C1',
    threadTs: '1.1',
    backendName: 'not-a-real-backend',
    repoName: 'anything',
    task: 'do something',
    requestedBy: 'U_OWNER',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'unknown-backend')
})

test('startAgentSession rejects an unregistered repo for an allowed user with a valid backend, before spawning anything', () =>
  withTempHome(async () => {
    const result = await startAgentSession({
      env: {},
      config: baseConfig,
      dbPath: '/tmp/should-never-be-touched.sqlite',
      channel: 'C1',
      threadTs: '1.1',
      backendName: 'claude',
      repoName: 'nonexistent-repo',
      task: 'do something',
      requestedBy: 'U_OWNER',
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'repo-not-found')
  }))

test('parseAgentSessionCommand defaults to the claude backend and no repo/model when no flags are given', () => {
  assert.deepEqual(parseAgentSessionCommand('fix the flaky test'), { backendName: 'claude', repoName: undefined, modelName: undefined, task: 'fix the flaky test' })
})

test('parseAgentSessionCommand extracts --backend, --repo and --model regardless of position, leaving the rest as the task', () => {
  assert.deepEqual(parseAgentSessionCommand('--backend codex fix --repo team-slack-bridge --model o3 the flaky test'), {
    backendName: 'codex',
    repoName: 'team-slack-bridge',
    modelName: 'o3',
    task: 'fix the flaky test',
  })
})

test('parseAgentSessionCommand with only flags and no task text returns an empty task', () => {
  assert.deepEqual(parseAgentSessionCommand('--backend gemini --repo x'), { backendName: 'gemini', repoName: 'x', modelName: undefined, task: '' })
})

test('parseAgentSessionCommand tolerates empty/whitespace-only input', () => {
  assert.deepEqual(parseAgentSessionCommand(''), { backendName: 'claude', repoName: undefined, modelName: undefined, task: '' })
  assert.deepEqual(parseAgentSessionCommand('   '), { backendName: 'claude', repoName: undefined, modelName: undefined, task: '' })
})

function fakeActiveSession(configOptions) {
  return { sessionId: 'sess-1', newSessionResponse: { configOptions } }
}

test('applyModelSelection matches a model by its display name, discovered from session/new\'s advertised config options (ACP-native, not hardcoded per backend)', async () => {
  const requests = []
  const connection = { agent: { request: async (method, params) => requests.push({ method, params }) } }
  const activeSession = fakeActiveSession([
    { id: 'model', category: 'model', options: [{ value: 'claude-opus-4', name: 'Opus' }, { value: 'claude-sonnet-4', name: 'Sonnet' }] },
  ])
  const result = await applyModelSelection({ connection, activeSession, modelName: 'opus' })
  assert.equal(result.ok, true)
  assert.equal(result.model, 'Opus')
  assert.deepEqual(requests[0].params, { sessionId: 'sess-1', configId: 'model', value: 'claude-opus-4' })
})

test('applyModelSelection matches a model by its raw value id too, not only its display name', async () => {
  const connection = { agent: { request: async () => {} } }
  const activeSession = fakeActiveSession([{ id: 'model', category: 'model', options: [{ value: 'claude-opus-4', name: 'Opus' }] }])
  const result = await applyModelSelection({ connection, activeSession, modelName: 'claude-opus-4' })
  assert.equal(result.ok, true)
})

test('applyModelSelection flattens grouped select options (some backends group choices by provider)', async () => {
  const connection = { agent: { request: async () => {} } }
  const activeSession = fakeActiveSession([
    { id: 'model', category: 'model', options: [{ group: 'anthropic', name: 'Anthropic', options: [{ value: 'claude-opus-4', name: 'Opus' }] }] },
  ])
  const result = await applyModelSelection({ connection, activeSession, modelName: 'opus' })
  assert.equal(result.ok, true)
})

test('applyModelSelection fails clearly, listing available choices, when the requested model does not exist', async () => {
  const connection = { agent: { request: async () => {} } }
  const activeSession = fakeActiveSession([{ id: 'model', category: 'model', options: [{ value: 'claude-opus-4', name: 'Opus' }] }])
  const result = await applyModelSelection({ connection, activeSession, modelName: 'gpt-5' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'unknown-model')
  assert.deepEqual(result.available, ['Opus'])
})

test('applyModelSelection fails clearly when the backend advertises no model selector at all', async () => {
  const connection = { agent: { request: async () => {} } }
  const activeSession = fakeActiveSession([{ id: 'mode', category: 'mode', options: [{ value: 'plan', name: 'Plan' }] }])
  const result = await applyModelSelection({ connection, activeSession, modelName: 'opus' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'backend-does-not-advertise-a-model-selector')
})

function tempDbPath() {
  return join(mkdtempSync(join(tmpdir(), 'tsb-acp-sessions-db-')), 'db.sqlite')
}

// routeThreadReply's resume fallback (PLAN: ACP thread sessions, Phase 4) —
// covering every guard clause that fails BEFORE ever spawning a backend
// connection, same "no-active-session-for-thread" shape as "never had a
// session" so callers always degrade to normal message handling.

test('routeThreadReply returns no-active-session-for-thread when nothing was ever persisted for this thread', async () => {
  const result = await routeThreadReply({ env: {}, config: baseConfig, dbPath: tempDbPath(), channel: 'C1', threadTs: '1.1', text: 'hi', requestedBy: 'U_OWNER' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-active-session-for-thread')
})

test('routeThreadReply refuses to resume a session an unauthorized user did not start (D24 applies to resume too)', async () => {
  const dbPath = tempDbPath()
  createAgentSession({
    dbPath,
    config: baseConfig,
    slackChannel: 'C1',
    slackThreadTs: '1.1',
    kind: 'acp-session',
    metadata: { backend: 'claude', repoPath: '/tmp', acpSessionId: 'sess-1' },
  })
  const result = await routeThreadReply({ env: {}, config: baseConfig, dbPath, channel: 'C1', threadTs: '1.1', text: 'hi', requestedBy: 'U_RANDOM' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-active-session-for-thread')
})

test('routeThreadReply will not resume a session that was explicitly closed', async () => {
  const dbPath = tempDbPath()
  const created = createAgentSession({
    dbPath,
    config: baseConfig,
    slackChannel: 'C1',
    slackThreadTs: '1.1',
    kind: 'acp-session',
    metadata: { backend: 'claude', repoPath: '/tmp', acpSessionId: 'sess-1' },
  })
  updateAgentSession({ dbPath, id: created.session.id, status: 'closed' })
  const result = await routeThreadReply({ env: {}, config: baseConfig, dbPath, channel: 'C1', threadTs: '1.1', text: 'hi', requestedBy: 'U_OWNER' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-active-session-for-thread')
})

test('routeThreadReply will not resume a non-ACP agent-session row (e.g. the older review-request kind)', async () => {
  const dbPath = tempDbPath()
  createAgentSession({ dbPath, config: baseConfig, slackChannel: 'C1', slackThreadTs: '1.1', kind: 'review-request', metadata: {} })
  const result = await routeThreadReply({ env: {}, config: baseConfig, dbPath, channel: 'C1', threadTs: '1.1', text: 'hi', requestedBy: 'U_OWNER' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-active-session-for-thread')
})

test('routeThreadReply will not resume a session with an unknown backend or missing ACP metadata, before ever connecting to anything', async () => {
  const dbPath = tempDbPath()
  createAgentSession({ dbPath, config: baseConfig, slackChannel: 'C1', slackThreadTs: '1.1', kind: 'acp-session', metadata: { backend: 'not-a-real-backend' } })
  const result = await routeThreadReply({ env: {}, config: baseConfig, dbPath, channel: 'C1', threadTs: '1.1', text: 'hi', requestedBy: 'U_OWNER' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-active-session-for-thread')
})

test('closeAgentSession with no in-memory session for the thread fails clearly instead of pretending to succeed', () => {
  const result = closeAgentSession({ dbPath: tempDbPath(), config: baseConfig, channel: 'C-never-had-one', threadTs: '9.9', requestedBy: 'U_OWNER' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-active-session-for-thread')
})

test('closeAgentSession refuses someone who neither started the session, nor is the owner, nor is an explicitly listed controller (D31 — start rights alone are not stop rights)', () => {
  const dbPath = tempDbPath()
  createAgentSession({
    dbPath,
    config: baseConfig,
    slackChannel: 'C1',
    slackThreadTs: '1.1',
    kind: 'acp-session',
    metadata: { backend: 'claude', repoPath: '/tmp', acpSessionId: 'sess-1', requestedBy: 'U_ALLOWED' },
  })
  const result = closeAgentSession({ dbPath, config: baseConfig, channel: 'C1', threadTs: '1.1', requestedBy: 'U_RANDOM' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'not-allowed-to-close-agent-session')
})

test('closeAgentSession allows the session\'s own starter, even though they are not the owner', () => {
  const dbPath = tempDbPath()
  createAgentSession({
    dbPath,
    config: baseConfig,
    slackChannel: 'C1',
    slackThreadTs: '1.1',
    kind: 'acp-session',
    metadata: { backend: 'claude', repoPath: '/tmp', acpSessionId: 'sess-1', requestedBy: 'U_ALLOWED' },
  })
  const result = closeAgentSession({ dbPath, config: baseConfig, channel: 'C1', threadTs: '1.1', requestedBy: 'U_ALLOWED' })
  assert.equal(result.ok, true)
})

test('closeAgentSession allows someone explicitly listed in agentSessions.allowedControllers, even though they did not start the session and are not the owner', () => {
  const dbPath = tempDbPath()
  const config = { ...baseConfig, agentSessions: { ...baseConfig.agentSessions, allowedControllers: ['U_CONTROLLER'] } }
  createAgentSession({
    dbPath,
    config,
    slackChannel: 'C1',
    slackThreadTs: '1.1',
    kind: 'acp-session',
    metadata: { backend: 'claude', repoPath: '/tmp', acpSessionId: 'sess-1', requestedBy: 'U_ALLOWED' },
  })
  const result = closeAgentSession({ dbPath, config, channel: 'C1', threadTs: '1.1', requestedBy: 'U_CONTROLLER' })
  assert.equal(result.ok, true)
})

test('closeAgentSession closes a session that was never resumed after a restart (DB-only, no in-memory entry) — this is what makes "stop"/"exit" work even before anyone replies to trigger a resume', () => {
  const dbPath = tempDbPath()
  const created = createAgentSession({
    dbPath,
    config: baseConfig,
    slackChannel: 'C1',
    slackThreadTs: '1.1',
    kind: 'acp-session',
    metadata: { backend: 'claude', repoPath: '/tmp', acpSessionId: 'sess-1' },
  })
  const result = closeAgentSession({ dbPath, config: baseConfig, channel: 'C1', threadTs: '1.1', requestedBy: 'U_OWNER' })
  assert.equal(result.ok, true)
  assert.equal(getAgentSession({ dbPath, id: created.session.id }).status, 'closed')
})

test('closeAgentSession on an already-closed session fails rather than reporting a false success', () => {
  const dbPath = tempDbPath()
  const created = createAgentSession({ dbPath, config: baseConfig, slackChannel: 'C1', slackThreadTs: '1.1', kind: 'acp-session', metadata: {} })
  updateAgentSession({ dbPath, id: created.session.id, status: 'closed' })
  const result = closeAgentSession({ dbPath, config: baseConfig, channel: 'C1', threadTs: '1.1', requestedBy: 'U_OWNER' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-active-session-for-thread')
})

// Regression test for a real bug found live: a rejected prompt() (Bedrock
// auth failure, connection drop, crashed backend) used to vanish silently
// — nextUpdate() waited forever for a 'stop' message that would never
// arrive, so the Slack progress message stayed on "starting…" forever.
test('runPromptTurn finishes (does not hang) when prompt() rejects, and reports the failure instead of swallowing it', async () => {
  const posted = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body))
    posted.push(body)
    return { status: 200, headers: new Headers(), url: url.toString(), text: async () => JSON.stringify({ ok: true, channel: body.channel, ts: '100.001' }) }
  }
  try {
    const fakeActiveSession = {
      prompt: () => Promise.reject(new Error('OAuth session expired and could not be refreshed')),
      nextUpdate: () => new Promise(() => {}), // never resolves — this is exactly what used to hang forever
    }
    const entry = {
      activeSession: fakeActiveSession,
      backend: { name: 'claude' },
      repoName: 'dashboard',
      progressTs: '100.001',
      channel: 'C1',
      env: { SLACK_BOT_TOKEN: 'xoxb-runprompt-test' },
      config: {},
      accumulatedText: '',
    }
    const response = await runPromptTurn(entry, 'do something')
    assert.equal(response.stopReason, 'error')
    const finish = posted.find(p => p.text?.includes('OAuth session expired'))
    assert.ok(finish, 'expected the error to be posted into the finishProgress call, not swallowed')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// A fake ActiveSession whose nextUpdate() drains one scripted batch of
// session_update notifications per prompt() call, then reports 'stop' —
// enough to exercise maybeWarnContextFull's own internal prompt() call
// (for the handoff self-summary) as a second, independent "turn".
function makeFakeSession(script) {
  let call = -1
  let queue = []
  return {
    prompt() {
      call++
      queue = [...(script[call] || [])]
      return Promise.resolve({ stopReason: 'end_turn' })
    },
    nextUpdate() {
      if (queue.length) return Promise.resolve(queue.shift())
      return Promise.resolve({ kind: 'stop', response: { stopReason: 'end_turn' } })
    },
  }
}

test('runPromptTurn writes a handoff file and gates the thread once usage crosses the configured threshold', async () => {
  await withTempHome(async () => {
    const posted = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const body = Object.fromEntries(new URLSearchParams(init.body))
      posted.push(body)
      return { status: 200, headers: new Headers(), url: url.toString(), text: async () => JSON.stringify({ ok: true, channel: body.channel, ts: '100.002' }) }
    }
    try {
      const fakeActiveSession = makeFakeSession([
        [{ kind: 'session_update', notification: { update: { sessionUpdate: 'usage_update', used: 90, size: 100 } } }],
        [], // the handoff self-summary prompt: no notifications, just stop
      ])
      const entry = {
        activeSession: fakeActiveSession,
        backend: { name: 'claude' },
        repoName: 'dashboard',
        progressTs: '100.001',
        channel: 'C1',
        threadTs: '100.001',
        env: { SLACK_BOT_TOKEN: 'xoxb-context-test' },
        config: { agentSessions: { contextWarningThreshold: 0.8 } },
        accumulatedText: '',
      }
      await runPromptTurn(entry, 'do the thing')
      assert.equal(entry.contextState, 'full')
      assert.ok(entry.handoffPath && existsSync(entry.handoffPath), 'expected a handoff file to be written')
      assert.match(entry.lastWarningText, /Context is at 90%/)
      assert.ok(posted.some(p => p.text?.includes('Context is at 90%')), 'expected the warning to actually be posted to Slack')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// Regression test for a race found live: two rapid messages in the same
// thread could both find no in-memory session and race into resuming it
// simultaneously, each clobbering the other's registered handlers.
test('withKeyLock serializes calls for the same key, one at a time in order', async () => {
  const order = []
  const key = 'C1:1.1'
  const first = withKeyLock(key, async () => {
    order.push('first-start')
    await new Promise(resolve => setTimeout(resolve, 20))
    order.push('first-end')
  })
  const second = withKeyLock(key, async () => {
    order.push('second-start')
  })
  await Promise.all([first, second])
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start'])
})

test('withKeyLock does not serialize calls for different keys', async () => {
  const order = []
  const a = withKeyLock('C1:1.1', async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    order.push('a')
  })
  const b = withKeyLock('C2:2.2', async () => {
    order.push('b')
  })
  await Promise.all([a, b])
  // b (no delay) finishes before a (20ms delay) since they run concurrently,
  // not queued behind each other.
  assert.deepEqual(order, ['b', 'a'])
})

test('withKeyLock lets the next caller proceed even if the previous one threw', async () => {
  const key = 'C1:1.1'
  await assert.rejects(() => withKeyLock(key, async () => { throw new Error('boom') }))
  const result = await withKeyLock(key, async () => 'ok')
  assert.equal(result, 'ok')
})
