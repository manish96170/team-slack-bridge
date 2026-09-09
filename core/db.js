// Shared node:sqlite connection (D10/D11) for both the idempotency ledger
// and the ask/approval correlation table (core/ask.js). One DB file, one
// cached connection per path — the ledger and asks are independent tables,
// not independent databases, since both exist to survive across separate
// process invocations of this repo (a short-lived MCP tool call, a
// long-lived listener process).

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const dbCache = new Map()

export function getDb(path) {
  let db = dbCache.get(path)
  if (db) return db
  mkdirSync(dirname(path), { recursive: true })
  db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      key TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      result TEXT,
      claimed_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS asks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      question TEXT NOT NULL,
      kind TEXT NOT NULL,
      channel TEXT,
      thread_ts TEXT,
      status TEXT NOT NULL,
      answer TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT
    );
  `)
  dbCache.set(path, db)
  return db
}
