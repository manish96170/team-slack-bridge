#!/usr/bin/env node
// node cli/upload.js --file-path ./screenshot.png [--channel '#x'] [--thread-ts ts]
//   [--title t] [--filename name] [--as-user] [--dry-run] [--json]
// Uploads a local file (e.g. a screenshot or video) via Slack's current
// files.getUploadURLExternal/completeUploadExternal flow, optionally sharing
// it straight into a channel/thread.

import { uploadFile } from '../core/files.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['as-user', 'dry-run', 'json'])
const { env } = loadContext()

if (!flags['file-path']) {
  console.error('usage: upload.js --file-path <path> [--channel <#channel>] [--thread-ts <ts>] [--title <t>] [--filename <name>] [--as-user] [--dry-run] [--json]')
  process.exit(1)
}

const result = await uploadFile({
  token: flags['as-user'] ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN,
  filePath: flags['file-path'],
  filename: flags.filename,
  title: flags.title,
  channel: flags.channel,
  threadTs: flags['thread-ts'],
  dryRun: flags['dry-run'],
})

output(result, { json: flags.json })
