#!/usr/bin/env node
// node cli/reply.js --channel '#x' --thread-ts '169…' --text 'hi' [--idempotency-key …] [--dry-run] [--json]

import { reply } from '../core/post.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext, LEDGER_PATH } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['dry-run', 'json'])
const { env, config } = loadContext()

if (!flags.channel || !flags['thread-ts'] || !flags.text) {
  console.error('usage: reply.js --channel <#channel> --thread-ts <ts> --text <text> [--idempotency-key <key>] [--dry-run] [--json]')
  process.exit(1)
}

const result = await reply({
  token: env.SLACK_BOT_TOKEN,
  channel: flags.channel,
  threadTs: flags['thread-ts'],
  text: flags.text,
  idempotencyKey: flags['idempotency-key'],
  ledgerPath: LEDGER_PATH,
  config,
  dryRun: flags['dry-run'],
})

output(result, { json: flags.json })
