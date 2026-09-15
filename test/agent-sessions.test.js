import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentSession, getAgentSession, updateAgentSession } from '../core/agent-sessions.js'

function tempDbPath() {
  return join(mkdtempSync(join(tmpdir(), 'agent-session-test-')), 'db.sqlite')
}

test('agent session creation is disabled unless explicitly enabled in config', () => {
  const result = createAgentSession({ dbPath: tempDbPath(), config: { agentSessions: { enabled: false } } })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'agent-sessions-disabled')
})

test('agent session creation records a session when enabled', () => {
  const result = createAgentSession({
    dbPath: tempDbPath(),
    config: { agentSessions: { enabled: true, provider: 'openacp' } },
    slackChannel: 'C1',
    slackThreadTs: '1.1',
    kind: 'review-request',
  })
  assert.equal(result.ok, true)
  assert.equal(result.session.provider, 'openacp')
  assert.equal(result.session.slackChannel, 'C1')
})

test('updateAgentSession persists a status transition (PLAN: ACP thread sessions, Phase 4 — closing must stick, or resume would treat a closed session as still live)', () => {
  const dbPath = tempDbPath()
  const created = createAgentSession({ dbPath, config: { agentSessions: { enabled: true } }, slackChannel: 'C1', slackThreadTs: '1.1', kind: 'acp-session' })
  const updated = updateAgentSession({ dbPath, id: created.session.id, status: 'closed' })
  assert.equal(updated.ok, true)
  assert.equal(updated.session.status, 'closed')
  assert.equal(getAgentSession({ dbPath, id: created.session.id }).status, 'closed')
})

test('updateAgentSession persists new metadata (e.g. the ACP sessionId, added after the row already exists)', () => {
  const dbPath = tempDbPath()
  const created = createAgentSession({
    dbPath,
    config: { agentSessions: { enabled: true } },
    slackChannel: 'C1',
    slackThreadTs: '1.1',
    kind: 'acp-session',
    metadata: { backend: 'claude' },
  })
  updateAgentSession({ dbPath, id: created.session.id, metadata: { backend: 'claude', acpSessionId: 'sess-123' } })
  assert.deepEqual(getAgentSession({ dbPath, id: created.session.id }).metadata, { backend: 'claude', acpSessionId: 'sess-123' })
})

test('updateAgentSession requires dbPath and id rather than silently no-oping', () => {
  const result = updateAgentSession({ status: 'closed' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'db-path-and-id-required')
})
