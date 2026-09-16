#!/usr/bin/env node
// Interactive setup (PLAN §4.4): asks for name / Slack handle / Slack user
// ID / Jira handle, and writes slack-config.json. No hardcoded handles
// anywhere else in this repo — this is the one place identity gets typed in.
//
// node cli/setup.js init
// node cli/setup.js add-user
// node cli/setup.js set-owner --user U0123ABC
// node cli/setup.js watch-channel --channel '#code-review' --purpose review-request
// node cli/setup.js dm-allow --user U0456DEF
// node cli/setup.js features                       (revisit the default-false toggles later)
// node cli/setup.js features --enable-http true     (skip a specific prompt non-interactively)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseFlags } from './lib/args.js'
import { CONFIG_PATH } from './context.js'
import { loadConfig } from '../core/identity.js'
import { ENV_FILE_PATH } from '../env.js'

function writeConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

function writeEnvValue(contents, key, value) {
  if (!value) return contents
  const line = `${key}=${value}`
  if (contents.match(new RegExp(`^${key}=.*$`, 'm'))) {
    return contents.replace(new RegExp(`^${key}=.*$`, 'm'), line)
  }
  return `${contents.replace(/\s*$/, '')}\n${line}\n`
}

function writeEnv(updates) {
  let contents = existsSync(ENV_FILE_PATH) ? readFileSync(ENV_FILE_PATH, 'utf8') : ''
  for (const [key, value] of Object.entries(updates)) contents = writeEnvValue(contents, key, value)
  mkdirSync(dirname(ENV_FILE_PATH), { recursive: true })
  writeFileSync(ENV_FILE_PATH, contents, { mode: 0o600 })
}

async function promptMissing(flags, questions) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answers = {}
  for (const [key, question] of Object.entries(questions)) {
    answers[key] = flags[key] || (await rl.question(question))
  }
  rl.close()
  return answers
}

// Every optional/risky surface in this repo defaults to false for a
// reason — each one is either an attack surface (http), an experimental
// integration (agentSessions, openacp, slackbotMcp), or needs a piece of
// setup this wizard can't verify (slashCommands needs interactivity
// enabled in the manifest). Asking explicitly, with a hint and "leave off
// if unsure" as the visible default, beats silently defaulting to off and
// hoping whoever wants one of these later finds it by reading the source.
const FEATURE_TOGGLES = [
  {
    key: 'http',
    flag: 'enable-http',
    label: 'Enable the HTTP surface',
    hint: 'an alternative to Socket Mode for slash commands/interactivity — opens a local port. Socket Mode (the listener) already covers this without one. Leave off unless you specifically need an HTTP endpoint',
  },
  {
    key: 'slashCommands',
    flag: 'enable-slash-commands',
    label: 'Enable Slack slash commands (/outputmode)',
    hint: 'requires Interactivity enabled in the Slack app manifest first (config/slack-app-manifest.template.json already has it) — leave off if you have not reinstalled the app with that setting yet',
  },
  {
    key: 'agentSessions',
    flag: 'enable-agent-sessions',
    label: 'Enable agent-session tracking',
    hint: 'links Slack threads to Claude Code/OpenCode sessions — leave off until you have picked a provider and know what should auto-create a session',
  },
  {
    key: 'openacp',
    flag: 'enable-openacp',
    label: 'Enable the OpenACP (Agent Client Protocol) adapter',
    hint: 'experimental cross-agent protocol integration — leave off unless you are actively working with OpenACP',
  },
  {
    key: 'slackbotMcp',
    flag: 'enable-slackbot-mcp',
    label: "Enable Slack's own remote MCP connector passthrough",
    hint: 'exposes this bridge as a remote MCP server through Slack itself — needs an HTTPS URL and an auth provider configured separately; leave off until those exist',
  },
]

async function promptFeatureToggles(flags) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const enabled = {}
  for (const toggle of FEATURE_TOGGLES) {
    const flagValue = flags[toggle.flag]
    if (flagValue !== undefined) {
      enabled[toggle.key] = flagValue === true || flagValue === 'true' || flagValue === 'y' || flagValue === 'yes'
      continue
    }
    const answer = (await rl.question(`${toggle.label}? (y/N — recommended: N if unsure) — ${toggle.hint}: `)).trim().toLowerCase()
    enabled[toggle.key] = answer === 'y' || answer === 'yes'
  }
  rl.close()
  return enabled
}

const [command] = process.argv.slice(2)
const flags = parseFlags(process.argv.slice(3), [])
const config = existsSync(CONFIG_PATH) ? loadConfig(CONFIG_PATH) : loadConfig('__missing__')

if (command === 'init') {
  const answers = await promptMissing(flags, {
    'bot-token': 'Slack bot token (xoxb-, paste locally; input is echoed): ',
    'app-token': 'Slack app token for Socket Mode (xapp-, optional but needed for listener): ',
    'signing-secret': 'Slack signing secret (optional, needed for HTTP/slash endpoints): ',
    owner: 'Owner Slack user ID (U...): ',
    channel: 'Watched channel ID or name (#code-review): ',
    purpose: 'Channel purpose (review-request|team-request): ',
    'output-mode': 'Output mode (low|medium|high, default medium): ',
  })
  const purpose = answers.purpose || 'review-request'
  if (!['review-request', 'team-request'].includes(purpose)) {
    console.error('purpose must be one of: review-request, team-request')
    process.exit(1)
  }
  const outputMode = answers['output-mode'] || 'medium'
  if (!['low', 'medium', 'high'].includes(outputMode)) {
    console.error('output mode must be one of: low, medium, high')
    process.exit(1)
  }

  const featureToggles = await promptFeatureToggles(flags)

  writeEnv({
    SLACK_BOT_TOKEN: answers['bot-token'],
    SLACK_APP_TOKEN: answers['app-token'],
    SLACK_SIGNING_SECRET: answers['signing-secret'],
  })
  config.owner = answers.owner ? { slackUserId: answers.owner } : config.owner
  config.outputMode = outputMode
  if (answers.channel) {
    config.watchedChannels = config.watchedChannels.filter(c => c.channel !== answers.channel)
    config.watchedChannels.push({ channel: answers.channel, purpose })
  }
  config.http = { ...config.http, enabled: featureToggles.http }
  config.slashCommands = { ...config.slashCommands, enabled: featureToggles.slashCommands }
  config.agentSessions = { ...config.agentSessions, enabled: featureToggles.agentSessions }
  config.openacp = { ...config.openacp, enabled: featureToggles.openacp }
  config.slackbotMcp = { ...config.slackbotMcp, enabled: featureToggles.slackbotMcp }
  writeConfig(config)

  const enabledFeatures = FEATURE_TOGGLES.filter(t => featureToggles[t.key]).map(t => t.label)
  console.log(`Initialized ${CONFIG_PATH} and ${ENV_FILE_PATH} (token values not printed).`)
  console.log(enabledFeatures.length ? `Enabled: ${enabledFeatures.join('; ')}` : 'All optional features left off (recommended default).')
} else if (command === 'add-user') {
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
  if (!['review-request', 'team-request'].includes(flags.purpose)) {
    console.error('purpose must be one of: review-request, team-request')
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
} else if (command === 'features') {
  // Revisit the optional/default-false toggles without re-running `init`'s
  // token/owner/channel prompts. `--<flag> true|false` skips the prompt for
  // that one toggle (see FEATURE_TOGGLES); anything not passed is asked
  // interactively, same wording and "leave off if unsure" default as init.
  const featureToggles = await promptFeatureToggles(flags)
  config.http = { ...config.http, enabled: featureToggles.http }
  config.slashCommands = { ...config.slashCommands, enabled: featureToggles.slashCommands }
  config.agentSessions = { ...config.agentSessions, enabled: featureToggles.agentSessions }
  config.openacp = { ...config.openacp, enabled: featureToggles.openacp }
  config.slackbotMcp = { ...config.slackbotMcp, enabled: featureToggles.slackbotMcp }
  writeConfig(config)

  const enabledFeatures = FEATURE_TOGGLES.filter(t => featureToggles[t.key]).map(t => t.label)
  console.log(`Updated ${CONFIG_PATH}.`)
  console.log(enabledFeatures.length ? `Enabled: ${enabledFeatures.join('; ')}` : 'All optional features left off.')
} else {
  console.error('usage: setup.js <init|add-user|set-owner|watch-channel|dm-allow|features> [...flags]')
  process.exit(1)
}
