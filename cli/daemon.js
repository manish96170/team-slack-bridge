#!/usr/bin/env node
// node cli/daemon.js start|stop|restart|status|logs [--account <name> | --all] [--lines 80] [--json]
//
// Without a flag it controls the registry's default account (unchanged
// behaviour). `--all` runs ONE supervisor serving every account that has a bot
// token, an app token and an owner. `status` with no flag lists every listener
// found under <TSB_HOME>/run/. `start` is idempotent, so a once-a-minute cron
// entry is a safe auto-restart.

import { logs, restart, start, status, statusAll, stop } from '../listen/daemon.js'
import { parseFlags, output } from './lib/args.js'

const [command] = process.argv.slice(2)
const flags = parseFlags(process.argv.slice(3), ['json', 'all'])
const name = flags.all ? 'all' : flags.account || 'default'
const explicit = Boolean(flags.all || flags.account)

let result
if (command === 'start') result = start(name)
else if (command === 'stop') result = stop(name)
else if (command === 'restart') result = restart(name)
else if (command === 'status') result = explicit ? status(name) : statusAll()
else if (command === 'logs') {
  result = logs({ name, lines: flags.lines ? Number(flags.lines) : undefined })
  if (!flags.json) {
    console.log(result.text)
    process.exit(0)
  }
} else {
  console.error('usage: daemon.js <start|stop|restart|status|logs> [--account <name> | --all] [--lines <n>] [--json]')
  process.exit(1)
}

if (command === 'status' && !explicit && !flags.json) {
  for (const item of result.listeners) console.log(`${item.name}: ${item.running ? `running (pid ${item.pid})` : 'stopped'}`)
  if (!result.listeners.length) console.log('No listeners have been started.')
} else output(result, { json: flags.json })
