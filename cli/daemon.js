#!/usr/bin/env node
// node cli/daemon.js start|stop|restart|status|logs [--lines 80] [--json]
//
// `start` is idempotent (no-ops if already running) — that makes
// `* * * * * cd <repo> && node cli/daemon.js start` a safe cron entry for
// auto-restart-on-crash, with no separate watchdog process needed.

import { logs, restart, start, status, stop } from '../listen/daemon.js'
import { parseFlags, output } from './lib/args.js'

const [command] = process.argv.slice(2)
const flags = parseFlags(process.argv.slice(3), ['json'])

let result
if (command === 'start') {
  result = start()
} else if (command === 'stop') {
  result = stop()
} else if (command === 'restart') {
  result = restart()
} else if (command === 'status') {
  result = status()
} else if (command === 'logs') {
  result = logs({ lines: flags.lines ? Number(flags.lines) : undefined })
  if (!flags.json) {
    console.log(result.text)
    process.exit(0)
  }
} else {
  console.error('usage: daemon.js <start|stop|restart|status|logs> [--lines <n>] [--json]')
  process.exit(1)
}

output(result, { json: flags.json })
