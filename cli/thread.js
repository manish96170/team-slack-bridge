#!/usr/bin/env node
// node cli/thread.js --channel '#x' --thread-ts '169…' [--as-user] [--json]

import { getThread } from '../core/query.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['as-user', 'json'])
const { env } = loadContext()

if (!flags.channel || !flags['thread-ts']) {
  console.error('usage: thread.js --channel <#channel> --thread-ts <ts> [--as-user] [--json]')
  process.exit(1)
}

const result = await getThread({
  token: flags['as-user'] ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN,
  channel: flags.channel,
  threadTs: flags['thread-ts'],
})

output(result, { json: flags.json })
