#!/usr/bin/env node
// node cli/home.js --user U0123ABC [--dry-run] [--json]
// Manually (re)publish the App Home feature-guide tab for one user — the
// listener does this automatically on app_home_opened; this is for testing
// the view without opening the tab, or refreshing it after an edit.

import { publishHome } from '../core/home.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['dry-run', 'json'])
const { env } = loadContext()

if (!flags.user) {
  console.error('usage: home.js --user <U0123ABC> [--dry-run] [--json]')
  process.exit(1)
}

const result = await publishHome({ token: env.SLACK_BOT_TOKEN, userId: flags.user, dryRun: flags['dry-run'] })

output(result, { json: flags.json })
