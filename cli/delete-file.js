#!/usr/bin/env node
// node cli/delete-file.js --file-id F123 [--account alias] [--via-bot] [--confirm] [--dry-run] [--json]
// Deletes the Slack file from ALL shares, not only the current channel/thread.

import { deleteLocalFile } from '../core/local-file-delete.js'
import { loadAccountContext, resolveAccountHome } from '../core/accounts.js'
import { parseFlags, output } from './lib/args.js'

const argv = process.argv.slice(2)
const fileIndex = argv.indexOf('--file-id')
if (fileIndex !== -1 && (!argv[fileIndex + 1] || argv[fileIndex + 1].startsWith('--'))) {
  output({ ok: false, error: 'fileId-required', retryable: false }, { json: argv.includes('--json') })
  process.exit(1)
}
const accountIndex = argv.indexOf('--account')
if (accountIndex !== -1 && (!argv[accountIndex + 1] || argv[accountIndex + 1].startsWith('--'))) {
  output({ ok: false, error: 'account-required', retryable: false }, { json: argv.includes('--json') })
  process.exit(1)
}
const flags = parseFlags(argv, ['via-bot', 'confirm', 'dry-run', 'json'])
if (!flags['file-id']) {
  console.error('usage: delete-file.js --file-id <Slack-file-id> [--account <alias>] [--via-bot] [--confirm] [--dry-run] [--json]')
  process.exit(1)
}

const resolved = resolveAccountHome(flags.account)
if (!resolved.ok) {
  output(resolved, { json: flags.json })
  process.exit(1)
}
const account = resolved.name
const ctx = loadAccountContext(account)
if (ctx.ok === false) {
  output(ctx, { json: flags.json })
} else {
  const tokenSource = flags['via-bot'] ? 'bot' : 'user'
  const result = await deleteLocalFile({
    env: ctx.env,
    config: ctx.config,
    dbPath: ctx.dbPath,
    fileId: flags['file-id'],
    confirm: flags.confirm,
    dryRun: flags['dry-run'],
    viaBot: flags['via-bot'],
  })
  if (result.warning && !flags.json) console.error(result.warning)
  output({ ...result, account, tokenSource }, { json: flags.json })
}
