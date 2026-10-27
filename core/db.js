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
    CREATE TABLE IF NOT EXISTS local_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      sender_user_id TEXT,
      sender_handle TEXT,
      sender_name TEXT,
      tool TEXT NOT NULL,
      via_bot INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      error TEXT,
      channel TEXT,
      ts TEXT
    );
    CREATE TABLE IF NOT EXISTS bot_send_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      sender_user_id TEXT NOT NULL,
      original_channel TEXT NOT NULL,
      original_ts TEXT NOT NULL,
      tracking_channel TEXT NOT NULL,
      tracking_parent_ts TEXT NOT NULL,
      tracking_reply_ts TEXT,
      anonymous INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS directory_people (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      handle TEXT,
      display_name TEXT,
      real_name TEXT,
      normalized_handle TEXT,
      normalized_display_name TEXT,
      normalized_real_name TEXT,
      refreshed_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS mpim_conversations (
      workspace_id TEXT NOT NULL,
      token_identity TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      member_key TEXT NOT NULL,
      refreshed_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, token_identity, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS mpim_members (
      workspace_id TEXT NOT NULL,
      token_identity TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      refreshed_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, token_identity, conversation_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_asks_thread_pending ON asks(channel, thread_ts, status);
    CREATE INDEX IF NOT EXISTS idx_ledger_status ON ledger(status);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_slack_thread ON agent_sessions(slack_channel, slack_thread_ts);
    CREATE INDEX IF NOT EXISTS idx_remote_audit_principal ON remote_audit(principal_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_local_audit_sender ON local_audit(sender_user_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_send_tracking_original ON bot_send_tracking(original_channel, original_ts);
    CREATE INDEX IF NOT EXISTS idx_directory_people_handle ON directory_people(workspace_id, normalized_handle);
    CREATE INDEX IF NOT EXISTS idx_directory_people_display_name ON directory_people(workspace_id, normalized_display_name);
    CREATE INDEX IF NOT EXISTS idx_directory_people_real_name ON directory_people(workspace_id, normalized_real_name);
    CREATE INDEX IF NOT EXISTS idx_mpim_conversations_member_key ON mpim_conversations(workspace_id, token_identity, member_key);
  `)
  dbCache.set(path, db)
  return db
}
