import { getDb } from './db.js'

export function recordRemoteAudit({ dbPath, principal, tool, ok, error, channel, ts }) {
  if (!dbPath) return
  getDb(dbPath)
    .prepare(
      `INSERT INTO remote_audit
       (created_at, principal_user_id, principal_team_id, tool, ok, error, channel, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      new Date().toISOString(),
      principal?.user_id || null,
      principal?.team_id || principal?.enterprise_id || null,
      tool,
      ok ? 1 : 0,
      error || null,
      channel || null,
      ts || null
    )
}

export function countRemoteCallsSince({ dbPath, principal, sinceIso }) {
  if (!dbPath || !principal?.user_id) return 0
  const row = getDb(dbPath)
    .prepare(
      `SELECT COUNT(*) AS count
       FROM remote_audit
       WHERE principal_user_id = ?
         AND created_at >= ?`
    )
    .get(principal.user_id, sinceIso)
  return row?.count || 0
}

export function reserveRemoteCall({ dbPath, principal, tool, rateLimitPerMinute, channel, ts }) {
  if (!dbPath || !principal?.user_id) return { ok: false, error: 'remote-mcp-db-required', retryable: false }

  const db = getDb(dbPath)
  const sinceIso = new Date(Date.now() - 60_000).toISOString()
  try {
    db.exec('BEGIN IMMEDIATE')
    const count = countRemoteCallsSince({ dbPath, principal, sinceIso })
    if (count >= rateLimitPerMinute) {
      db.exec('ROLLBACK')
      return { ok: false, error: 'remote-mcp-rate-limit-exceeded', retryable: true }
    }
    const result = db
      .prepare(
        `INSERT INTO remote_audit
         (created_at, principal_user_id, principal_team_id, tool, ok, error, channel, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        new Date().toISOString(),
        principal.user_id,
        principal.team_id || principal.enterprise_id || null,
        tool,
        0,
        'reserved',
        channel || null,
        ts || null
      )
    db.exec('COMMIT')
    return { ok: true, auditId: result.lastInsertRowid }
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    return { ok: false, error: err.message || 'remote-mcp-rate-limit-error', retryable: true }
  }
}

export function updateRemoteAudit({ dbPath, auditId, ok, error, channel, ts }) {
  if (!dbPath || !auditId) return
  getDb(dbPath)
    .prepare('UPDATE remote_audit SET ok = ?, error = ?, channel = COALESCE(?, channel), ts = COALESCE(?, ts) WHERE id = ?')
    .run(ok ? 1 : 0, error || null, channel || null, ts || null, auditId)
}
