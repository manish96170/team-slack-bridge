#!/usr/bin/env node
// node cli/unschedule.js --channel '#x' --scheduled-id Q1234567890 [--as-user] [--dry-run] [--json]

import { deleteScheduledMessage } from '../core/schedule.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['as-user', 'dry-run', 'json'])
const { env } = loadContext()

if (!flags.channel || !flags['scheduled-id']) {
  console.error('usage: unschedule.js --channel <#channel> --scheduled-id <id> [--as-user] [--dry-run] [--json]')
  process.exit(1)
}

const result = await deleteScheduledMessage({
  token: flags['as-user'] ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN,
  channel: flags.channel,
  scheduledMessageId: flags['scheduled-id'],
  dryRun: flags['dry-run'],
})

output(result, { json: flags.json })
