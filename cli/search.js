#!/usr/bin/env node
// node cli/search.js --query 'from:@bob deploy' [--json]
// Requires a user token — search is per-person by Slack's own construction.

import { search } from '../core/query.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['json'])
const { env } = loadContext()

if (!flags.query) {
  console.error('usage: search.js --query <text> [--json]')
  process.exit(1)
}

const result = await search({ userToken: env.SLACK_USER_TOKEN, query: flags.query })

output(result, { json: flags.json })
