#!/usr/bin/env node
// node cli/dm.js --user U0123ABC --text 'hi' [--as-user] [--dry-run] [--json]

import { dm } from '../core/dm.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext, LEDGER_PATH } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['as-user', 'dry-run', 'json'])
const { env, config } = loadContext()

if (!flags.user || !flags.text) {
  console.error('usage: dm.js --user <U0123ABC> --text <text> [--as-user] [--dry-run] [--json]')
  process.exit(1)
}

const result = await dm({
  botToken: env.SLACK_BOT_TOKEN,
  userToken: env.SLACK_USER_TOKEN,
  userId: flags.user,
  text: flags.text,
  asUser: flags['as-user'],
  config,
  dbPath: LEDGER_PATH,
  dryRun: flags['dry-run'],
})

output(result, { json: flags.json })
