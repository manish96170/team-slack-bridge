#!/usr/bin/env node
// node cli/group-dm-create.js --to "Shrestha,Manish,Alex" [--company <alias>] [--topic "<text>"] [--text "<first message>"] --confirm [--dry-run] [--json]
//
// Starts a NEW group DM (MPIM) as the account's authorized human. Opening a
// group is visible to every member, so a real creation needs --confirm; without
// it the command refuses and lists who would be included. An exact existing
// group is never modified -- its conversation ID is returned instead.

import { createGroupByName } from '../core/mpim.js'
import { loadAccountContext } from '../core/accounts.js'
import { parseFlags } from './lib/args.js'

const flags = parseFlags(process.argv.slice(2), ['confirm', 'dry-run', 'json'])
const peopleNames = (flags.to || '').split(',').map(name => name.trim()).filter(Boolean)

if (peopleNames.length < 2) {
  console.error('usage: group-dm-create.js --to "<person>,<person>[,...]" [--company <alias>] [--topic "<text>"] [--text "<first message>"] --confirm [--dry-run] [--json]')
  process.exit(1)
}

const context = loadAccountContext(flags.company)
const result = !context.ok
  ? context
  : await createGroupByName({
      peopleNames,
      topic: flags.topic,
      text: flags.text,
      confirm: flags.confirm,
      userToken: context.env.SLACK_USER_TOKEN,
      dbPath: context.dbPath,
      dryRun: flags['dry-run'],
    })

const output = context.ok ? { ...result, account: context.accountName } : result
if (flags.json) console.log(JSON.stringify(output))
else if (!output.ok) console.error(`Error: ${output.error}${output.retryable ? ' (retryable)' : ''}`)
else if (output.dryRun) console.log(output.existing ? `[dry-run] group DM already exists: ${output.conversationId}` : `[dry-run] would call ${output.request.method}: ${JSON.stringify(output.request.body)}`)
else console.log(output.created ? `Created group DM ${output.conversationId} as the locally authorized user.` : `Group DM ${output.conversationId} already existed; nothing was changed.`)
process.exitCode = output.ok ? 0 : 1
