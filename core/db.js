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
  // D37 — WAL + busy_timeout are a correctness prerequisite for N
  // concurrent processes sharing the same sqlite file (the listener
  // daemon, ACP session handlers, and hook processes all hit this).
  // Default rollback-journal mode takes an exclusive lock on writes and
  // returns SQLITE_BUSY immediately with no retry to a colliding reader;
  // WAL allows concurrent reads alongside a single writer, and
  // busy_timeout makes a blocked caller retry for up to 5s before giving
  // up, rather than failing instantly.
  // busy_timeout FIRST — it must be in place before journal_mode=WAL, which
  // itself can hit a lock if another process already has the file open.
  db.exec('PRAGMA busy_timeout=5000')
  db.exec('PRAGMA journal_mode=WAL')
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
    CREATE TABLE IF NOT EXISTS dm_channels (
      user_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      source TEXT NOT NULL,
      slack_channel TEXT,
      slack_thread_ts TEXT,
      kind TEXT,
      status TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remote_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      principal_user_id TEXT,
      principal_team_id TEXT,
      tool TEXT NOT NULL,
      ok INTEGER NOT NULL,
      error TEXT,
      channel TEXT,
      ts TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_asks_thread_pending ON asks(channel, thread_ts, status);
    CREATE INDEX IF NOT EXISTS idx_ledger_status ON ledger(status);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_slack_thread ON agent_sessions(slack_channel, slack_thread_ts);
    CREATE INDEX IF NOT EXISTS idx_remote_audit_principal ON remote_audit(principal_user_id, created_at);
  `)
  dbCache.set(path, db)
  return db
}
