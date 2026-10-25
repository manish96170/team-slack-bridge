// Local audit trail for bot-attributed sends (PLAN D47). Mirrors
// core/remote-audit.js's shape but keyed by the install's resolved sender
// (core/sender.js) instead of an authenticated remote principal — there is
// no authenticated caller identity to log on a local stdio install, only
// the owner this install is configured for. Written only for `viaBot:true`
// sends, since an as-user send already has a Slack-native audit trail
// (Slack itself knows who posted it).

import { getDb } from './db.js'

export function recordLocalAudit({ dbPath, sender, tool, viaBot, ok, error, channel, ts }) {
  if (!dbPath) return
  getDb(dbPath)
    .prepare(
      `INSERT INTO local_audit
       (created_at, sender_user_id, sender_handle, sender_name, tool, via_bot, ok, error, channel, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      new Date().toISOString(),
      sender?.slackUserId || null,
      sender?.slackHandle || null,
      sender?.name || null,
      tool,
      viaBot ? 1 : 0,
      ok ? 1 : 0,
      error || null,
      channel || null,
      ts || null
    )
}

export function queryLocalAudit({ dbPath, limit = 50 }) {
  if (!dbPath) return []
  return getDb(dbPath).prepare(`SELECT * FROM local_audit ORDER BY created_at DESC LIMIT ?`).all(limit)
}
