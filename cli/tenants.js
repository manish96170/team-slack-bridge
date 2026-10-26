#!/usr/bin/env node
// node cli/tenants.js add <teamId> [--home <path>] [--enterprise-id <id>]
// node cli/tenants.js list
// node cli/tenants.js remove <teamId>
//
// Multi-tenancy Phase 2 (ROADMAP.md), hand-provisioning half (PLAN D54):
// manages <TSB_HOME>/tenants.json, mapping a Slack team_id to its own home
// directory -- same shape as cli/accounts.js (D21), keyed by team_id
// instead of an operator name, and reachable from the hosted/remote
// profile once slackbotMcp.tenancy.mode is "multi" (core/tenancy.js never
// imports core/accounts.js's local-only registry for this).
//
// After `add`, run `TSB_HOME=<home> node cli/setup.js init` (or `TSB_HOME=<home>
// tsb-setup init` from a global npm install) against the new home dir to fill in
// that tenant's own .env/slack-config.json -- same pattern as cli/accounts.js,
// reusing the existing setup wizard instead of a second one. `add` only
// registers the home path; it never asks for or stores a token itself, so
// there is never a secret to protect inside tenants.json in the first place.

import { addTenant, defaultTenantHome, listTenants, removeTenant } from '../core/tenant-store.js'
import { parseFlags, output } from './lib/args.js'

const rest = process.argv.slice(2)
const command = rest[0]
const teamId = rest.slice(1).find(arg => !arg.startsWith('--'))
const flags = parseFlags(rest, ['json'])

let result
if (command === 'add') {
  result = addTenant(teamId, { home: flags.home, enterpriseId: flags['enterprise-id'] })
  if (result.ok) {
    console.error(`Next: TSB_HOME=${result.home} node cli/setup.js init   (or: TSB_HOME=${result.home} tsb-setup init)`)
  }
} else if (command === 'list') {
  result = listTenants()
} else if (command === 'remove') {
  result = removeTenant(teamId)
} else if (command === 'default-home') {
  result = { ok: true, teamId, home: defaultTenantHome(teamId) }
} else {
  console.error('usage: tenants.js <add <teamId> [--home <path>] [--enterprise-id <id>]|list|remove <teamId>> [--json]')
  process.exit(1)
}

output(result, { json: flags.json })
