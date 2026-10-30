#!/usr/bin/env node
// node cli/group-dm-by-name.js --to "Shrestha,Manish,Alex" [--company <alias>] --text "hi" --confirm [--dry-run] [--json]
//
// Existing group-DM (MPIM) messaging only. Resolves people in one local
// account and sends AS that account's authorized human; it never uses the
// shared bot and never silently creates/opens a group. If the exact member
// set has no existing MPIM, it returns mpim-not-found-confirm-create-first
// so a human can choose whether creation is wanted later. A real send needs
// --confirm (only after the human approved this exact text and recipients);
// without it the command refuses and prints what it would send.

import { messageGroupByName } from '../core/mpim.js'
import { loadAccountContext } from '../core/accounts.js'
import { parseFlags } from './lib/args.js'

const flags = parseFlags(process.argv.slice(2), ['confirm', 'dry-run', 'json'])
const peopleNames = (flags.to || '').split(',').map(name => name.trim()).filter(Boolean)

if (peopleNames.length < 2 || !flags.text) {
  console.error('usage: group-dm-by-name.js --to "<person>,<person>[,...]" [--company <alias>] --text "<text>" --confirm [--dry-run] [--json]')
  process.exit(1)
}

const context = loadAccountContext(flags.company)
const result = !context.ok
  ? context
  : await messageGroupByName({
      peopleNames,
      text: flags.text,
      confirm: flags.confirm,
      userToken: context.env.SLACK_USER_TOKEN,
      dbPath: context.dbPath,
      dryRun: flags['dry-run'],
    })

const output = context.ok ? { ...result, account: context.accountName } : result
if (flags.json) console.log(JSON.stringify(output))
else if (!output.ok) console.error(`Error: ${output.error}${output.retryable ? ' (retryable)' : ''}`)
else if (output.dryRun) console.log(`[dry-run] would message existing MPIM ${output.conversationId} as the locally authorized user`)
else console.log(`Sent as the locally authorized user to existing MPIM ${output.conversationId}.`)
process.exitCode = output.ok ? 0 : 1
