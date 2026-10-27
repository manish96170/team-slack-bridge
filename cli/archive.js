#!/usr/bin/env node
// node cli/archive.js export [--before <ISO date>] [--dry-run] [--json]
//
// Exports (gzipped JSON) and deletes rows older than the cutoff (default:
// the first day of the current month) from every table in .ledger.sqlite
// that accumulates over time, then VACUUMs so the file actually shrinks
// on disk -- see core/archive.js for why plain DELETE isn't enough.
//
// Safe to run on a schedule, same posture as `cli/daemon.js start` being
// "safe as a cron entry": idempotent, a no-op if nothing is older than
// the cutoff. A monthly cron entry keeps a long-running install's
// database from growing forever:
//   0 3 1 * * TSB_HOME=/path/to/home node /path/to/cli/archive.js export --json >> /path/to/archive.log 2>&1

import { archiveOldData } from '../core/archive.js'
import { parseFlags } from './lib/args.js'
import { HOME_DIR, LEDGER_PATH } from './context.js'
import { join } from 'node:path'

const command = process.argv[2]
const flags = parseFlags(process.argv.slice(2), ['dry-run', 'json'])

if (command !== 'export') {
  console.error('usage: archive.js export [--before <ISO date>] [--dry-run] [--json]')
  process.exit(1)
}

const result = archiveOldData({
  dbPath: LEDGER_PATH,
  archiveDir: join(HOME_DIR, 'archives'),
  before: flags.before,
  dryRun: flags['dry-run'],
})

if (flags.json) {
  console.log(JSON.stringify(result))
} else if (!result.ok) {
  console.error(`Error: ${result.error}${result.retryable ? ' (retryable)' : ''}`)
} else if (result.totalRows === 0) {
  console.log(`Nothing older than ${result.cutoff} — database already clean.`)
} else if (result.dryRun) {
  console.log(`[dry-run] would archive and delete ${result.totalRows} row(s) older than ${result.cutoff}:`)
  console.log(JSON.stringify(result.perTable, null, 2))
} else {
  console.log(`Archived ${result.totalRows} row(s) older than ${result.cutoff} to ${result.archivePath}, then deleted and VACUUMed.`)
  console.log(JSON.stringify(result.perTable, null, 2))
}
process.exitCode = result.ok ? 0 : 1
