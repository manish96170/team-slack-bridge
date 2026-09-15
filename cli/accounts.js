#!/usr/bin/env node
// node cli/accounts.js add <name> --home <path>
// node cli/accounts.js list
// node cli/accounts.js remove <name>
// node cli/accounts.js set-default <name>
//
// Manages ~/.team-slack-bridge/accounts.json (PLAN D21) — purely local,
// opt-in multi-account support. Never touched by the remote/hosted profile.
// After `add`, run `TSB_HOME=<path> node cli/setup.js init` against the new
// home dir to fill in that account's own .env/slack-config.json — this
// reuses the existing setup wizard per account instead of inventing a new
// one.

import { addAccount, listAccounts, removeAccount, setDefaultAccount } from '../core/accounts.js'
import { parseFlags, output } from './lib/args.js'

const rest = process.argv.slice(2)
const command = rest[0]
const name = rest.slice(1).find(arg => !arg.startsWith('--'))
const flags = parseFlags(rest, ['json'])

let result
if (command === 'add') {
  result = flags.home ? addAccount(name, flags.home) : { ok: false, error: 'home-required', retryable: false }
} else if (command === 'list') {
  result = { ok: true, ...listAccounts() }
} else if (command === 'remove') {
  result = removeAccount(name)
} else if (command === 'set-default') {
  result = setDefaultAccount(name)
} else {
  console.error('usage: accounts.js <add <name> --home <path>|list|remove <name>|set-default <name>> [--json]')
  process.exit(1)
}

output(result, { json: flags.json })
