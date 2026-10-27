#!/usr/bin/env node
// node cli/dm-by-name.js --to "<person name>" [--company <alias>] --text "<text>" [--as-user] [--dry-run] [--json]
//
// Plain-English cross-company messaging (ROADMAP.md, PLAN D64) — "DM
// <person> in <company>: <text>" without ever typing a raw Slack user ID
// or a TSB_HOME path. --company resolves through core/accounts.js's
// name->home registry (D21) — register an alias first with
// `node cli/accounts.js add <alias> --home <path>` (or, from a global
// install, `tsb-accounts add <alias> --home <path>`) if it isn't
// registered yet; see core/accounts.js's own header for the matching
// `tsb-setup init` step against that new home. For an existing install
// where a company is only registered in tenants.json (team_id-keyed,
// D54), it has to be registered here too under a friendly name before
// "in <that company>" means anything — tenants.json and accounts.json
// are deliberately separate registries (ROADMAP.md).
//
// --company omitted falls back to the registry's own default
// (`node cli/accounts.js set-default <alias>`). If no company is named
// AND no default is configured either, this refuses with
// `no-company-specified-and-no-default-configured` rather than
// guessing — see skill/SKILL.md for the agent-facing instruction to ask
// which company instead of picking one.

import { dmByName } from '../core/people.js'
import { parseFlags } from './lib/args.js'

const flags = parseFlags(process.argv.slice(2), ['as-user', 'dry-run', 'json'])

if (!flags.to || !flags.text) {
  console.error('usage: dm-by-name.js --to "<person name>" [--company <alias>] --text "<text>" [--as-user] [--dry-run] [--json]')
  process.exit(1)
}

const result = await dmByName({
  accountName: flags.company,
  personName: flags.to,
  text: flags.text,
  asUser: flags['as-user'],
  dryRun: flags['dry-run'],
})

// Manual output, not cli/lib/args.js's output() — that helper's dry-run
// branch assumes a flat Slack-call shape (result.request.method); this
// result nests a resolved account AND person around dm()'s own send
// result, same reason cli/archive.js already rolled its own output
// instead of forcing a differently-shaped result through output().
if (flags.json) {
  console.log(JSON.stringify(result))
} else if (!result.ok) {
  console.error(`Error: ${result.error}${result.retryable ? ' (retryable)' : ''}`)
} else {
  const who = `${result.person.displayName || result.person.handle || result.person.id} (${result.person.id})`
  if (result.send?.dryRun) {
    console.log(`[dry-run] would DM ${who} in account "${result.account}": ${JSON.stringify(result.send.request)}`)
  } else {
    console.log(`Sent to ${who} in account "${result.account}".`)
  }
}
process.exitCode = result.ok ? 0 : 1
