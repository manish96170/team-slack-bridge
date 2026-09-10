import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentSession } from '../core/agent-sessions.js'

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
