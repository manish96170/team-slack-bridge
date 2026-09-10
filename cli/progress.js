#!/usr/bin/env node
// node cli/progress.js start --channel '#x' --label 'Deploy' [--detail '...'] [--thread-ts ts] [--json]
// node cli/progress.js update --channel '#x' --ts ts --label 'Deploy' --status running [--detail '...'] [--json]
// node cli/progress.js finish --channel '#x' --ts ts --label 'Deploy' [--ok false] [--detail '...'] [--json]

import { startProgress, updateProgress, finishProgress } from '../core/progress.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext, LEDGER_PATH } from './context.js'

const [command] = process.argv.slice(2)
const flags = parseFlags(process.argv.slice(3), ['dry-run', 'json'])
const { env, config } = loadContext()

if (!['start', 'update', 'finish'].includes(command)) {
  console.error('usage: progress.js <start|update|finish> [...flags]')
  process.exit(1)
}

if (!flags.channel || !flags.label || (command !== 'start' && !flags.ts)) {
  console.error('usage: progress.js start --channel <#channel> --label <label> | progress.js <update|finish> --channel <#channel> --ts <ts> --label <label>')
  process.exit(1)
}

const base = {
  token: env.SLACK_BOT_TOKEN,
  channel: flags.channel,
  label: flags.label,
  detail: flags.detail,
  ledgerPath: LEDGER_PATH,
  config,
  dryRun: flags['dry-run'],
}

const result =
  command === 'start'
    ? await startProgress({ ...base, threadTs: flags['thread-ts'], idempotencyKey: flags['idempotency-key'] })
    : command === 'update'
      ? await updateProgress({ ...base, ts: flags.ts, status: flags.status || 'running' })
      : await finishProgress({ ...base, ts: flags.ts, ok: flags.ok !== 'false' })

output(result, { json: flags.json })
