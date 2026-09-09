// Idempotency ledger for outbound sends (PLAN §4.1). Claim a key BEFORE the
// side effect runs, not after — otherwise a retried send is a duplicate
// message.
//
// Backed by node:sqlite (D10/D11, 2026-09-09): a JSON file was fine while
// only one process ever posted at a time, but the Socket Mode listener
// (D8/D9) can now post concurrently with a CLI/MCP/dashboard call against
// the same install, and a JSON file's read-modify-write is not safe under
// that. node:sqlite is Node's own built-in module (stable since Node 22.5) —
// this is the one addition D7 asks for a written reason on, and this is it:
// real concurrency, not a speculative one. No npm dependency added.
//
// Shares its connection (core/db.js) with core/ask.js's `asks` table — same
// DB file, same reason: both need to survive across separate process
// invocations of this repo.

import { getDb } from './db.js'

function rowToEntry(row) {
  if (!row) return null
  return {
    status: row.status,
    result: row.result ? JSON.parse(row.result) : undefined,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at ?? undefined,
  }
}

// Returns the existing entry if this key was already claimed (caller must
// not repeat the side effect — a `status: 'done'` entry carries the
// previous result to return instead). Returns null if this call newly
// claimed the key, meaning the caller should proceed. The INSERT is atomic
// per-connection: a concurrent second claim on the same key hits the
// PRIMARY KEY constraint and falls through to reading the winner's row.
export function claim(path, key) {
  if (!key) return null
  const db = getDb(path)
  try {
    db.prepare('INSERT INTO ledger (key, status, claimed_at) VALUES (?, ?, ?)').run(key, 'pending', new Date().toISOString())
    return null
  } catch (err) {
    if (!String(err.message).includes('UNIQUE constraint failed')) throw err
    const row = db.prepare('SELECT * FROM ledger WHERE key = ?').get(key)
    return rowToEntry(row)
  }
}

export function complete(path, key, result) {
  if (!key) return
  const db = getDb(path)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO ledger (key, status, result, claimed_at, completed_at) VALUES (?, 'done', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET status = 'done', result = excluded.result, completed_at = excluded.completed_at`
  ).run(key, JSON.stringify(result), now, now)
}

export function findByTs(path, channel, ts) {
  const db = getDb(path)
  const rows = db.prepare("SELECT * FROM ledger WHERE status = 'done'").all()
  for (const row of rows) {
    const entry = rowToEntry(row)
    if (entry.result?.channel === channel && entry.result?.ts === ts) return entry
  }
  return null
}

export function all(path) {
  const db = getDb(path)
  const rows = db.prepare('SELECT * FROM ledger').all()
  const out = {}
  for (const row of rows) out[row.key] = rowToEntry(row)
  return out
}
