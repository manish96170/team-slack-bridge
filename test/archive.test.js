import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from '../core/db.js'
import { archiveOldData, startOfCurrentMonth } from '../core/archive.js'

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-archive-'))
  const dbPath = join(dir, '.ledger.sqlite')
  try {
    return fn(dbPath, join(dir, 'archives'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function seed(dbPath) {
  const db = getDb(dbPath)
  db.prepare(`INSERT INTO ledger (key, status, claimed_at) VALUES (?, ?, ?)`).run('old-key', 'done', '2020-01-01T00:00:00.000Z')
  db.prepare(`INSERT INTO ledger (key, status, claimed_at) VALUES (?, ?, ?)`).run('new-key', 'done', new Date().toISOString())
  db.prepare(`INSERT INTO asks (id, user_id, question, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('ask-old', 'U1', 'q?', 'question', 'answered', '2020-01-01T00:00:00.000Z')
  db.prepare(`INSERT INTO asks (id, user_id, question, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('ask-new', 'U1', 'q?', 'question', 'answered', new Date().toISOString())
}

test('startOfCurrentMonth returns midnight on day 1 of the current month, as an ISO string', () => {
  const now = new Date(2026, 9, 15, 13, 45) // Oct 15 2026, local time
  assert.equal(startOfCurrentMonth(now), new Date(2026, 9, 1, 0, 0, 0, 0).toISOString())
})

test('archiveOldData is a no-op when nothing is older than the cutoff', () => {
  withTempDb((dbPath, archiveDir) => {
    const db = getDb(dbPath)
    db.prepare(`INSERT INTO ledger (key, status, claimed_at) VALUES (?, ?, ?)`).run('k', 'done', new Date().toISOString())
    const result = archiveOldData({ dbPath, archiveDir })
    assert.equal(result.ok, true)
    assert.equal(result.totalRows, 0)
    assert.equal(result.archivePath, null)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 1)
  })
})

test('archiveOldData dry-run reports counts but deletes nothing and writes no file', () => {
  withTempDb((dbPath, archiveDir) => {
    seed(dbPath)
    const result = archiveOldData({ dbPath, archiveDir, dryRun: true })
    assert.equal(result.ok, true)
    assert.equal(result.dryRun, true)
    assert.equal(result.totalRows, 2)
    assert.equal(result.perTable.ledger, 1)
    assert.equal(result.perTable.asks, 1)
    assert.equal(result.archivePath, null)

    const db = getDb(dbPath)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 2)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asks').get().n, 2)
    assert.throws(() => readdirSync(archiveDir))
  })
})

test('archiveOldData exports old rows to a gzipped JSON archive, deletes them, and keeps current-month rows', () => {
  withTempDb((dbPath, archiveDir) => {
    seed(dbPath)
    const result = archiveOldData({ dbPath, archiveDir })
    assert.equal(result.ok, true)
    assert.equal(result.totalRows, 2)
    assert.ok(result.archivePath)

    const db = getDb(dbPath)
    assert.deepEqual(db.prepare('SELECT key FROM ledger').all().map(r => r.key), ['new-key'])
    assert.deepEqual(db.prepare('SELECT id FROM asks').all().map(r => r.id), ['ask-new'])

    const archived = JSON.parse(gunzipSync(readFileSync(result.archivePath)).toString('utf8'))
    assert.equal(archived.tables.ledger[0].key, 'old-key')
    assert.equal(archived.tables.asks[0].id, 'ask-old')
  })
})

test('archiveOldData accepts an explicit --before cutoff instead of the current-month default', () => {
  withTempDb((dbPath, archiveDir) => {
    const db = getDb(dbPath)
    db.prepare(`INSERT INTO ledger (key, status, claimed_at) VALUES (?, ?, ?)`).run('a', 'done', '2026-05-01T00:00:00.000Z')
    db.prepare(`INSERT INTO ledger (key, status, claimed_at) VALUES (?, ?, ?)`).run('b', 'done', '2026-07-01T00:00:00.000Z')

    const result = archiveOldData({ dbPath, archiveDir, before: '2026-06-01T00:00:00.000Z' })
    assert.equal(result.totalRows, 1)
    assert.deepEqual(db.prepare('SELECT key FROM ledger').all().map(r => r.key), ['b'])
  })
})

test('archiveOldData the archive file is written 0600', () => {
  if (process.platform === 'win32') return
  withTempDb((dbPath, archiveDir) => {
    seed(dbPath)
    const result = archiveOldData({ dbPath, archiveDir })
    assert.equal(statSync(result.archivePath).mode & 0o777, 0o600)
  })
})

test('archiveOldData running twice in a row is idempotent — second run finds nothing left to archive', () => {
  withTempDb((dbPath, archiveDir) => {
    seed(dbPath)
    const first = archiveOldData({ dbPath, archiveDir })
    assert.equal(first.totalRows, 2)
    const second = archiveOldData({ dbPath, archiveDir })
    assert.equal(second.totalRows, 0)
    assert.equal(second.archivePath, null)
  })
})

test('archiveOldData requires dbPath rather than silently no-oping', () => {
  const result = archiveOldData({ archiveDir: '/tmp/whatever' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'dbPath-required')
})

test('archiveOldData rejects an invalid cutoff rather than lexicographically deleting every timestamped row', () => {
  const result = archiveOldData({ dbPath: '/tmp/tsb-archive-invalid.sqlite', archiveDir: '/tmp/whatever', before: 'not-a-date' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'before-must-be-an-iso-date')
})
