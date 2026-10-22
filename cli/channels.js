#!/usr/bin/env node
// node cli/channels.js [--types 'public_channel,private_channel'] [--limit 100] [--cursor <c>] [--json]
// Requires a user token — lists the conversations the authorized human user
// is a member of, not every channel in the workspace (PLAN D41, §13).

import { listMyChannels } from '../core/channels.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['json'])
const { env } = loadContext()

const result = await listMyChannels({
  token: env.SLACK_USER_TOKEN,
  types: flags.types,
  limit: flags.limit ? Number(flags.limit) : undefined,
  cursor: flags.cursor,
})

output(result, { json: flags.json })
