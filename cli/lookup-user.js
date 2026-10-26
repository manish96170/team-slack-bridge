#!/usr/bin/env node
// node cli/lookup-user.js --query <U.../email@x.com/@handle/"Full Name"> [--mode auto|id|email|handle|name] [--as-user] [--include-email] [--json]
//
// Live Slack-directory lookup (PLAN D50/D51) — resolves someone who is NOT
// necessarily in slack-config.json's `users` list, via a real Slack API
// call. Separate from resolve-user.js, which stays config-file-only and
// untouched. Defaults to the shared bot token; --as-user switches to
// SLACK_USER_TOKEN instead — same flag name and meaning as every other
// --as-user CLI command in this repo, never a silent fallback either way.

import { lookupUser } from '../core/directory.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['as-user', 'include-email', 'json'])
const { env, config } = loadContext()

if (!flags.query) {
  console.error('usage: lookup-user.js --query <U.../email/@handle/name> [--mode auto|id|email|handle|name] [--as-user] [--include-email] [--json]')
  process.exit(1)
}

const tokenSource = flags['as-user'] ? 'user' : 'bot'

const result = await lookupUser({
  query: flags.query,
  mode: flags.mode,
  includeEmail: flags['include-email'],
  tokenSource,
  token: tokenSource === 'user' ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN,
  ttlMs: config?.directoryLookup?.cacheTtlMs,
})

output(result, { json: flags.json })
