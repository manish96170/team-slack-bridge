#!/usr/bin/env node
// node cli/thread.js --channel '#x' --thread-ts '169…' [--json]

import { getThread } from '../core/query.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['json'])
const { env } = loadContext()

if (!flags.channel || !flags['thread-ts']) {
  console.error('usage: thread.js --channel <#channel> --thread-ts <ts> [--json]')
  process.exit(1)
}

const result = await getThread({
  token: env.SLACK_BOT_TOKEN,
  channel: flags.channel,
  threadTs: flags['thread-ts'],
})

output(result, { json: flags.json })
