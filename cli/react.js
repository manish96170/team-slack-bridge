#!/usr/bin/env node
// node cli/react.js --channel '#x' --ts '169…' --emoji eyes [--dry-run] [--json]

import { react } from '../core/post.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['dry-run', 'json'])
const { env } = loadContext()

if (!flags.channel || !flags.ts || !flags.emoji) {
  console.error('usage: react.js --channel <#channel> --ts <ts> --emoji <name> [--dry-run] [--json]')
  process.exit(1)
}

const result = await react({
  token: env.SLACK_BOT_TOKEN,
  channel: flags.channel,
  ts: flags.ts,
  emoji: flags.emoji,
  dryRun: flags['dry-run'],
})

output(result, { json: flags.json })
