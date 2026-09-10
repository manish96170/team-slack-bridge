#!/usr/bin/env node
// node cli/update.js --channel '#x' --ts '169…' --text 'new text' [--as-user] [--dry-run] [--json]
// --as-user is required if the original message was posted as-user — Slack
// only allows editing a message with the same identity that authored it.

import { updateMessage } from '../core/post.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext, LEDGER_PATH } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['as-user', 'dry-run', 'json'])
const { env, config } = loadContext()

if (!flags.channel || !flags.ts || !flags.text) {
  console.error('usage: update.js --channel <#channel> --ts <ts> --text <text> [--as-user] [--dry-run] [--json]')
  process.exit(1)
}

const result = await updateMessage({
  token: flags['as-user'] ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN,
  channel: flags.channel,
  ts: flags.ts,
  text: flags.text,
  ledgerPath: LEDGER_PATH,
  config,
  dryRun: flags['dry-run'],
})

output(result, { json: flags.json })
