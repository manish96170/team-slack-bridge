import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'

function rowToSession(row) {
  if (!row) return null
  return {
    id: row.id,
    provider: row.provider,
    source: row.source,
    slackChannel: row.slack_channel,
    slackThreadTs: row.slack_thread_ts,
    kind: row.kind,
    status: row.status,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createAgentSession({ dbPath, config, source = 'slack', slackChannel, slackThreadTs, kind, metadata = {} }) {
  if (!dbPath) return { ok: false, error: 'db-path-required', retryable: false }
  if (!config?.agentSessions?.enabled) return { ok: false, error: 'agent-sessions-disabled', retryable: false }

  const now = new Date().toISOString()
  const id = randomUUID()
  getDb(dbPath)
    .prepare(
      `INSERT INTO agent_sessions
       (id, provider, source, slack_channel, slack_thread_ts, kind, status, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, config.agentSessions.provider || 'none', source, slackChannel, slackThreadTs, kind, 'created', JSON.stringify(metadata), now, now)
  return { ok: true, session: getAgentSession({ dbPath, id }) }
}

// Used by ACP session resume (PLAN: ACP thread sessions, Phase 4) to persist
// the ACP sessionId at creation and the 'closed' status on explicit close —
// without this, every session (even a deliberately closed one) would look
// eligible for resume forever, since `status` otherwise never leaves
// 'created'.
export function updateAgentSession({ dbPath, id, metadata, status }) {
  if (!dbPath || !id) return { ok: false, error: 'db-path-and-id-required', retryable: false }
  const now = new Date().toISOString()
  const db = getDb(dbPath)
  if (metadata !== undefined) db.prepare('UPDATE agent_sessions SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(metadata), now, id)
  if (status !== undefined) db.prepare('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id)
  return { ok: true, session: getAgentSession({ dbPath, id }) }
}

export function getAgentSession({ dbPath, id }) {
  if (!dbPath) return null
  return rowToSession(getDb(dbPath).prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id))
}

export function findAgentSessionBySlackThread({ dbPath, slackChannel, slackThreadTs }) {
  if (!dbPath || !slackChannel || !slackThreadTs) return null
  return rowToSession(
    getDb(dbPath)
      .prepare('SELECT * FROM agent_sessions WHERE slack_channel = ? AND slack_thread_ts = ? ORDER BY created_at DESC LIMIT 1')
      .get(slackChannel, slackThreadTs)
  )
}

export function maybeCreateAgentSessionForEvent({ dbPath, config, classified }) {
  if (!config?.agentSessions?.enabled || !config.agentSessions.autoCreateSession) {
    return { ok: true, created: false, reason: 'agent-session-auto-create-disabled' }
  }
  const event = classified?.event
  return createAgentSession({
    dbPath,
    config,
    source: 'slack',
    slackChannel: event?.channel,
    slackThreadTs: event?.thread_ts || event?.ts,
    kind: classified?.kind,
    metadata: { classifiedKind: classified?.kind, user: event?.user },
  })
}
