#!/usr/bin/env node
// node cli/repos.js add <name> --path <absolute-path>
// node cli/repos.js list
// node cli/repos.js remove <name>
// node cli/repos.js set-default <name>
//
// Manages ~/.team-slack-bridge/repos.json (PLAN D23) — the named registry an
// ACP agent session's fs/terminal access is scoped to. A session picks a
// name, never a raw path.

import { addRepo, listRepos, removeRepo, setDefaultRepo } from '../core/repos.js'
import { parseFlags, output } from './lib/args.js'

const rest = process.argv.slice(2)
const command = rest[0]
const name = rest.slice(1).find(arg => !arg.startsWith('--'))
const flags = parseFlags(rest, ['json'])

let result
if (command === 'add') {
  result = flags.path ? addRepo(name, flags.path) : { ok: false, error: 'path-required', retryable: false }
} else if (command === 'list') {
  result = { ok: true, ...listRepos() }
} else if (command === 'remove') {
  result = removeRepo(name)
} else if (command === 'set-default') {
  result = setDefaultRepo(name)
} else {
  console.error('usage: repos.js <add <name> --path <path>|list|remove <name>|set-default <name>> [--json]')
  process.exit(1)
}

output(result, { json: flags.json })
