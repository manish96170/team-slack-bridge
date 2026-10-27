// Database retention (PLAN D63): .ledger.sqlite accumulates rows forever
// across every table that logs something over time (ledger, asks,
// agent_sessions, remote_audit, local_audit, bot_send_tracking,
// dm_channels, directory_people, mpim_conversations) --
// nothing has ever pruned it, so a long-running install's
// database file only grows. This exports anything older than a cutoff
// (default: the first day of the current month) to a gzipped JSON archive
// file, deletes those rows from the live database, then runs VACUUM so
// the .ledger.sqlite file actually shrinks on disk -- SQLite does not
// reclaim space from DELETE alone; without VACUUM the file size would
// never go down even though the rows are gone.
//
// Export happens BEFORE delete, and only deletes if the archive write
// succeeded, so a failure here never loses data -- worst case is running
// again later with nothing new having been deleted.

import { writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { getDb } from './db.js'

// timestampColumn is what each row is aged by. dm_channels has no
// append-only history semantics (it's a cache of the last-opened DM
// channel per user, core/dm.js), but it still accumulates one row per
// person ever DMed and is included for the same disk-growth reason --
// pruning it just means the next send re-opens the conversation.
const TABLES = [
  { name: 'ledger', timestampColumn: 'claimed_at' },
  { name: 'asks', timestampColumn: 'created_at' },
  { name: 'dm_channels', timestampColumn: 'updated_at' },
  { name: 'agent_sessions', timestampColumn: 'created_at' },
  { name: 'remote_audit', timestampColumn: 'created_at' },
  { name: 'local_audit', timestampColumn: 'created_at' },
  { name: 'bot_send_tracking', timestampColumn: 'created_at' },
  { name: 'directory_people', timestampColumn: 'refreshed_at' },
  { name: 'mpim_conversations', timestampColumn: 'refreshed_at' },
]

export function startOfCurrentMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).toISOString()
}

export function archiveOldData({ dbPath, archiveDir, before, dryRun }) {
  if (!dbPath) return { ok: false, error: 'dbPath-required', retryable: false }
  if (before && Number.isNaN(Date.parse(before))) return { ok: false, error: 'before-must-be-an-iso-date', retryable: false }
  const db = getDb(dbPath)
  const cutoff = before ? new Date(before).toISOString() : startOfCurrentMonth()

  const tables = {}
  let totalRows = 0
  for (const { name, timestampColumn } of TABLES) {
    const rows = db.prepare(`SELECT * FROM ${name} WHERE ${timestampColumn} < ?`).all(cutoff)
    tables[name] = rows
    totalRows += rows.length
  }

  const perTable = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]))

  if (totalRows === 0) {
    return { ok: true, cutoff, totalRows: 0, perTable, archivePath: null, dryRun: !!dryRun }
  }

  if (dryRun) {
    return { ok: true, cutoff, totalRows, perTable, archivePath: null, dryRun: true }
  }

  mkdirSync(archiveDir, { recursive: true })
  const exportedAt = new Date().toISOString()
  const archivePath = join(archiveDir, `archive-${cutoff.slice(0, 10)}-${exportedAt.replace(/[:.]/g, '-')}.json.gz`)
  const payload = JSON.stringify({ exportedAt, cutoff, tables }, null, 2)
  writeFileSync(archivePath, gzipSync(payload), { mode: 0o600 })
  chmodSync(archivePath, 0o600)

  // Only delete once the archive write above has actually landed on disk.
  for (const { name, timestampColumn } of TABLES) {
    db.prepare(`DELETE FROM ${name} WHERE ${timestampColumn} < ?`).run(cutoff)
  }
  db.exec('VACUUM')

  return { ok: true, cutoff, totalRows, perTable, archivePath, dryRun: false }
}
