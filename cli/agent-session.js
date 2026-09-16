#!/usr/bin/env node
// node cli/agent-session.js create [--channel C123] [--thread-ts ts] [--kind review-request] [--json]
// node cli/agent-session.js list [--status active|closed|created] [--kind acp-session] [--limit 20] [--json]

import { createAgentSession, listAgentSessions } from '../core/agent-sessions.js'
import { parseFlags, output } from './lib/args.js'
import { LEDGER_PATH, loadContext } from './context.js'

const [command] = process.argv.slice(2)
const flags = parseFlags(process.argv.slice(3), ['json'])
const { config } = loadContext()

if (command === 'list') {
  const sessions = listAgentSessions({
    dbPath: LEDGER_PATH,
    status: flags.status,
    kind: flags.kind,
    limit: flags.limit ? Number(flags.limit) : undefined,
  })
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, sessions }))
  } else if (!sessions.length) {
    console.log('No agent sessions recorded.')
  } else {
    for (const s of sessions) {
      const backend = s.metadata?.backend
      const repo = s.metadata?.repoName
      console.log(`${s.status.padEnd(9)} ${s.kind.padEnd(14)} ${s.slackChannel}/${s.slackThreadTs}  ${backend ? `${backend}${repo ? ` · ${repo}` : ''}  ` : ''}${s.createdAt}`)
    }
  }
  process.exit(0)
}

if (command !== 'create') {
  console.error('usage: agent-session.js <create [--channel <C123>] [--thread-ts <ts>] [--kind <kind>] | list [--status <status>] [--kind <kind>] [--limit <n>]> [--json]')
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
