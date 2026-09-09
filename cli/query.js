#!/usr/bin/env node
// node cli/query.js --channel '#x' [--since-minutes 60] [--limit 20] [--json]

import { queryMessages } from '../core/query.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['json'])
const { env } = loadContext()

if (!flags.channel) {
  console.error('usage: query.js --channel <#channel> [--since-minutes <n>] [--limit <n>] [--json]')
  process.exit(1)
}

const result = await queryMessages({
  token: env.SLACK_BOT_TOKEN,
  channel: flags.channel,
  sinceMinutes: flags['since-minutes'] ? Number(flags['since-minutes']) : undefined,
  limit: flags.limit ? Number(flags.limit) : undefined,
})

output(result, { json: flags.json })
