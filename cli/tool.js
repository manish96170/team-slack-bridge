#!/usr/bin/env node
// node cli/tool.js <tool-name> [--args '<json>'] [--company <alias>] [--dry-run] [--json]
//
// Runs any local MCP tool (mcp/tools.local.js) from the shell, so the D72
// feature tools — slack_call, slack_canvas, slack_pin, slack_bookmark,
// slack_reminder, slack_usergroup_lookup, slack_file, slack_huddle_status,
// slack_set_status, slack_set_presence, slack_dnd, slack_resolve_link — are
// reachable from the CLI, the skill and scripts exactly as from MCP. It goes
// through the SAME handler and the SAME schema validation as the MCP server,
// so the CLI cannot behave differently from it.
//
//   node cli/tool.js slack_resolve_link --args '{"link":"https://x.slack.com/archives/C1/p1793337025613279"}'
//   node cli/tool.js slack_pin --args '{"action":"list","channel":"C0123ABCD"}' --company anchor
//   node cli/tool.js --list
//
// --company selects a registered account alias (core/accounts.js); omitted
// uses the registry's default. --dry-run is shorthand for "dryRun":true in the
// arguments for tools that support it.

import { tools } from '../mcp/tools.local.js'
import { validateArguments } from '../mcp/validation.js'
import { loadAccountContext } from '../core/accounts.js'
import { parseFlags } from './lib/args.js'

const argv = process.argv.slice(2)
const toolName = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined
const flags = parseFlags(toolName ? argv.slice(1) : argv, ['dry-run', 'json', 'list'])

function fail(message, code = 1) {
  console.error(message)
  process.exit(code)
}

if (flags.list) {
  for (const name of Object.keys(tools).sort()) console.log(name)
  process.exit(0)
}

if (!toolName) fail("usage: tool.js <tool-name> [--args '<json>'] [--company <alias>] [--dry-run] [--json]   (tool.js --list for names)")
const tool = tools[toolName]
if (!tool) fail(`unknown tool: ${toolName}`)

let args = {}
if (flags.args) {
  try {
    args = JSON.parse(flags.args)
  } catch (err) {
    fail(`--args must be valid JSON: ${err.message}`)
  }
}
if (flags['dry-run']) args = { ...args, dryRun: true }

const validationError = validateArguments(tool.inputSchema, args)
if (validationError) fail(`Error: ${validationError}`)

const context = loadAccountContext(flags.company)
const result = !context.ok ? context : await tool.handler(args, context)
const output = context.ok ? { ...result, account: context.accountName } : result

if (flags.json) console.log(JSON.stringify(output))
else console.log(JSON.stringify(output, null, 2))
process.exitCode = output.ok ? 0 : 1
