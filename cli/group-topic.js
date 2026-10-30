#!/usr/bin/env node
// node cli/group-topic.js --channel G0123ABCD --topic "Release sync" --confirm [--company <alias>] [--dry-run] [--json]
//
// Sets the topic of an existing group DM (MPIM) as the account's authorized
// human. Refuses anything that is not a group DM.

import { setGroupTopic } from '../core/mpim.js'
import { loadAccountContext } from '../core/accounts.js'
import { parseFlags } from './lib/args.js'

const flags = parseFlags(process.argv.slice(2), ['confirm', 'dry-run', 'json'])

if (!flags.channel || flags.topic === undefined) {
  console.error('usage: group-topic.js --channel <G…> --topic "<text>" --confirm [--company <alias>] [--dry-run] [--json]')
  process.exit(1)
}

const context = loadAccountContext(flags.company)
const result = !context.ok
  ? context
  : await setGroupTopic({ channel: flags.channel, topic: flags.topic, confirm: flags.confirm, userToken: context.env.SLACK_USER_TOKEN, dryRun: flags['dry-run'] })

const output = context.ok ? { ...result, account: context.accountName } : result
if (flags.json) console.log(JSON.stringify(output))
else if (!output.ok) console.error(`Error: ${output.error}${output.retryable ? ' (retryable)' : ''}`)
else if (output.dryRun) console.log(`[dry-run] would set the topic of group DM ${output.channel}`)
else console.log(`Topic set on group DM ${output.channel}.`)
process.exitCode = output.ok ? 0 : 1
