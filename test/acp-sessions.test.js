import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAllowedToStartSession, startAgentSession, routeThreadReply, closeAgentSession, parseAgentSessionCommand, applyModelSelection } from '../core/acp-sessions.js'
import { createAgentSession, updateAgentSession, getAgentSession } from '../core/agent-sessions.js'

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-acp-sessions-'))
  const original = process.env.TSB_HOME
  process.env.TSB_HOME = dir
  try {
    return fn(dir)
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

test('closeAgentSession refuses a non-allowed user, same D24 gate as starting a session (anyone in the channel should not be able to end someone else\'s session)', () => {
  const result = closeAgentSession({ dbPath: tempDbPath(), config: baseConfig, channel: 'C1', threadTs: '1.1', requestedBy: 'U_RANDOM' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'not-allowed-to-close-agent-session')
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
