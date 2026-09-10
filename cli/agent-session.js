#!/usr/bin/env node
// node cli/agent-session.js create [--channel C123] [--thread-ts ts] [--kind review-request] [--json]

import { createAgentSession } from '../core/agent-sessions.js'
import { parseFlags, output } from './lib/args.js'
import { LEDGER_PATH, loadContext } from './context.js'

const [command] = process.argv.slice(2)
const flags = parseFlags(process.argv.slice(3), ['json'])
const { config } = loadContext()

if (command !== 'create') {
  console.error('usage: agent-session.js create [--channel <C123>] [--thread-ts <ts>] [--kind <kind>] [--json]')
  process.exit(1)
}

const result = createAgentSession({
  dbPath: LEDGER_PATH,
  config,
  source: 'manual',
  slackChannel: flags.channel,
  slackThreadTs: flags['thread-ts'],
  kind: flags.kind,
})

output(result, { json: flags.json })
