import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAllowedToStartSession, startAgentSession } from '../core/acp-sessions.js'

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
