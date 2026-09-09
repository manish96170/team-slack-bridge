#!/usr/bin/env node
// node cli/schedule.js --channel '#x' --text 'hi' --at '2026-09-10T09:00:00-07:00' [--thread-ts …] [--as-user] [--dry-run] [--json]
// --at accepts an ISO-8601 timestamp or raw Unix seconds.

import { scheduleMessage } from '../core/schedule.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['as-user', 'dry-run', 'json'])
const { env } = loadContext()

if (!flags.channel || !flags.text || !flags.at) {
  console.error('usage: schedule.js --channel <#channel> --text <text> --at <ISO-timestamp|unix-seconds> [--thread-ts <ts>] [--as-user] [--dry-run] [--json]')
  process.exit(1)
}

const result = await scheduleMessage({
  token: flags['as-user'] ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN,
  channel: flags.channel,
  text: flags.text,
  threadTs: flags['thread-ts'],
  postAt: /^\d+$/.test(flags.at) ? Number(flags.at) : flags.at,
  dryRun: flags['dry-run'],
})

output(result, { json: flags.json })
