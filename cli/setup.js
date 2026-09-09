#!/usr/bin/env node
// Interactive setup (PLAN §4.4): asks for name / Slack handle / Slack user
// ID / Jira handle, and writes slack-config.json. No hardcoded handles
// anywhere else in this repo — this is the one place identity gets typed in.
//
// node cli/setup.js add-user
// node cli/setup.js set-owner --user U0123ABC
// node cli/setup.js watch-channel --channel '#code-review' --purpose review-request
// node cli/setup.js dm-allow --user U0456DEF

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { parseFlags } from './lib/args.js'
import { CONFIG_PATH } from './context.js'
import { loadConfig } from '../core/identity.js'

function writeConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

const [command] = process.argv.slice(2)
const flags = parseFlags(process.argv.slice(3), [])
const config = existsSync(CONFIG_PATH) ? loadConfig(CONFIG_PATH) : loadConfig('__missing__')

if (command === 'add-user') {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const name = await rl.question('Name: ')
  const slackHandle = await rl.question('Slack handle (e.g. @jane): ')
  const slackUserId = await rl.question('Slack user ID (Profile > Copy member ID, e.g. U0123ABC): ')
  const jiraHandle = await rl.question('Jira handle (optional, enter to skip): ')
  rl.close()

  config.users = config.users.filter(u => u.slackUserId !== slackUserId)
  config.users.push({ name, slackHandle, slackUserId, ...(jiraHandle ? { jiraHandle } : {}) })
  writeConfig(config)
  console.log(`Added ${name} (${slackUserId}) to ${CONFIG_PATH}`)
} else if (command === 'set-owner') {
  if (!flags.user) {
    console.error('usage: setup.js set-owner --user <U0123ABC>')
    process.exit(1)
  }
  config.owner = { slackUserId: flags.user }
  writeConfig(config)
  console.log(`Owner set to ${flags.user}`)
} else if (command === 'watch-channel') {
  if (!flags.channel || !flags.purpose) {
    console.error('usage: setup.js watch-channel --channel <#channel-or-id> --purpose <review-request|team-request>')
    process.exit(1)
  }
  config.watchedChannels = config.watchedChannels.filter(c => c.channel !== flags.channel)
  config.watchedChannels.push({ channel: flags.channel, purpose: flags.purpose })
  writeConfig(config)
  console.log(`Watching ${flags.channel} for ${flags.purpose}`)
} else if (command === 'dm-allow') {
  if (!flags.user) {
    console.error('usage: setup.js dm-allow --user <U0123ABC>')
    process.exit(1)
  }
  config.dmAllowlist = [...new Set([...(config.dmAllowlist || []), flags.user])]
  writeConfig(config)
  console.log(`${flags.user} may now DM the bridge (classified as dm-request, never self-dm — that stays owner-only)`)
} else {
  console.error('usage: setup.js <add-user|set-owner|watch-channel|dm-allow> [...flags]')
  process.exit(1)
}
