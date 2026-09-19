#!/usr/bin/env node
// node cli/away.js on|off|status [--timeout-seconds 3600] [--max-continuations 3] [--json]
//
// Toggles away mode: when on, Claude Code hooks route permission requests
// and stop decisions to Slack instead of the local terminal.

import { isAway, setAway, getAwayFlagPath, getAwayConfig } from '../core/away.js'
import { parseFlags, output } from './lib/args.js'

const [command] = process.argv.slice(2)
const flags = parseFlags(process.argv.slice(3), ['json'])

let result
if (command === 'on') {
  result = setAway(true, {
    timeoutSeconds: flags['timeout-seconds'] ? Number(flags['timeout-seconds']) : undefined,
    maxContinuations: flags['max-continuations'] ? Number(flags['max-continuations']) : undefined,
  })
} else if (command === 'off') {
  result = setAway(false)
} else if (command === 'status') {
  const away = isAway()
  const config = away ? getAwayConfig() : null
  result = { ok: true, away, path: getAwayFlagPath(), ...(config || {}) }
} else {
  console.error('usage: away.js <on|off|status> [--timeout-seconds <n>] [--max-continuations <n>] [--json]')
  process.exit(1)
}

output(result, { json: flags.json })
