#!/usr/bin/env node
// node cli/post.js --channel '#x' --text 'hi' [--thread-ts …] [--as-user] [--idempotency-key …] [--dry-run] [--json]

import { postToChannel } from '../core/post.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext, LEDGER_PATH } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['as-user', 'dry-run', 'json'])
const { env, config } = loadContext()

if (!flags.channel || !flags.text) {
  console.error('usage: post.js --channel <#channel> --text <text> [--thread-ts <ts>] [--as-user] [--idempotency-key <key>] [--dry-run] [--json]')
  process.exit(1)
}

const result = await postToChannel({
  token: flags['as-user'] ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN,
  channel: flags.channel,
  text: flags.text,
  threadTs: flags['thread-ts'],
  idempotencyKey: flags['idempotency-key'],
  ledgerPath: LEDGER_PATH,
  config,
  dryRun: flags['dry-run'],
})

output(result, { json: flags.json })
