#!/usr/bin/env node
// node cli/ask.js --user U0123ABC --question 'Deploy to prod?' --kind approval [--options 'Approve,Deny'] [--timeout 300] [--capture-mode listener|poll] [--json]
//
// Blocks until answered or the timeout elapses. `--kind approval` requires
// the Socket Mode listener (cli/listen.js) to be running — a button click
// is never visible to a direct poll (see core/ask.js). `--kind question`
// (the default) works either way.

import { ask } from '../core/ask.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext, LEDGER_PATH } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['json'])
const { env } = loadContext()

if (!flags.user || !flags.question) {
  console.error(
    "usage: ask.js --user <U0123ABC> --question <text> [--kind question|approval] [--options 'Approve,Deny'] [--timeout <seconds>] [--capture-mode listener|poll] [--json]"
  )
  process.exit(1)
}

const result = await ask({
  botToken: env.SLACK_BOT_TOKEN,
  userId: flags.user,
  question: flags.question,
  kind: flags.kind || 'question',
  options: flags.options ? flags.options.split(',').map(s => s.trim()) : undefined,
  dbPath: LEDGER_PATH,
  timeoutSeconds: flags.timeout ? Number(flags.timeout) : undefined,
  captureMode: flags['capture-mode'] || 'listener',
})

output(result, { json: flags.json })
