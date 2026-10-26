#!/usr/bin/env node
// node cli/delete.js --channel '#x' --ts '169…' [--as-user] [--dry-run] [--json]

import { deleteMessage } from '../core/post.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext, LEDGER_PATH } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['as-user', 'dry-run', 'json'])
const { env } = loadContext()

if (!flags.channel || !flags.ts) {
  console.error('usage: delete.js --channel <#channel> --ts <ts> [--as-user] [--dry-run] [--json]')
  process.exit(1)
}

const result = await deleteMessage({
  token: flags['as-user'] ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN,
  channel: flags.channel,
  ts: flags.ts,
  ledgerPath: LEDGER_PATH,
  dryRun: flags['dry-run'],
})

output(result, { json: flags.json })
