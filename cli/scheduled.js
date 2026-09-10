#!/usr/bin/env node
// node cli/scheduled.js [--channel '#x'] [--limit 20] [--as-user] [--json]
// Lists messages scheduled but not yet posted.

import { listScheduledMessages } from '../core/schedule.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['as-user', 'json'])
const { env } = loadContext()

const result = await listScheduledMessages({
  token: flags['as-user'] ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN,
  channel: flags.channel,
  limit: flags.limit ? Number(flags.limit) : undefined,
})

output(result, { json: flags.json })
