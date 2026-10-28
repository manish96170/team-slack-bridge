import { deleteFile } from './file-delete.js'
import { getDb } from './db.js'

export function queryLocalFileAudit({ dbPath, limit = 50 }) {
  if (!dbPath) return []
  return getDb(dbPath).prepare('SELECT * FROM local_file_audit ORDER BY id DESC LIMIT ?').all(limit)
}

// Local MCP and CLI are trusted-user surfaces, but deletion is irreversible:
// require a separate account-level opt-in and persist an intent before calling Slack.
export async function deleteLocalFile({ env = {}, config = {}, dbPath, fileId, confirm, dryRun, viaBot }) {
  const tokenSource = viaBot ? 'bot' : 'user'
  const token = viaBot ? env.SLACK_BOT_TOKEN : env.SLACK_USER_TOKEN
  if (dryRun || confirm !== true) return { ...(await deleteFile({ token, fileId, confirm, dryRun })), tokenSource }
  if (!dbPath) return { ok: false, error: 'file-deletion-audit-db-required', retryable: false, tokenSource }
  const normalizedFileId = typeof fileId === 'string' ? fileId.trim() : ''
  let db, auditId
  try {
    db = getDb(dbPath)
    auditId = db.prepare('INSERT INTO local_file_audit (created_at, file_id, token_source, configured_owner_id, status) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), normalizedFileId, tokenSource, config.owner?.slackUserId || null, 'pending').lastInsertRowid
  } catch {
    return { ok: false, error: 'file-deletion-audit-unavailable', retryable: false, tokenSource }
  }
  const result = config.fileDeletion?.enabled
    ? await deleteFile({ token, fileId: normalizedFileId, confirm, dryRun })
    : { ok: false, error: 'file-deletion-disabled', retryable: false }
  try {
    db.prepare('UPDATE local_file_audit SET status = ?, error = ? WHERE id = ?')
      .run(result.outcomeUnknown ? 'unknown' : result.ok ? 'success' : 'failed', result.error || null, auditId)
  } catch {
    // The pending intent remains; do not pretend the Slack operation did not run.
    return { ...result, auditUpdateFailed: true, tokenSource }
  }
  return { ...result, tokenSource }
}
