#!/usr/bin/env node
// Thin process wrapper around listen/socket.js (D9: library first, process
// second). Run this directly for a standalone install, or skip it entirely
// and have the dashboard's supervisor call createListener() in-process —
// both are supported on purpose.
//
// node cli/listen.js [--json]
//
// Requires SLACK_BOT_TOKEN and SLACK_APP_TOKEN (xapp-…, from Socket Mode
// setup) in .env, plus an owner (and optionally a dmAllowlist) in
// slack-config.json. Classified events are printed one JSON object per
// line to stdout — this process does not act on them, only reports them
// (§4.2: emit, do not act).

import { createListener } from '../listen/socket.js'
import { createSupervisor } from '../core/supervisor.js'
import { parseFlags } from './lib/args.js'
import { CONFIG_PATH, HOME_DIR, loadContext, LEDGER_PATH } from './context.js'

// node cli/listen.js                 the registry's default account (unchanged)
// node cli/listen.js --account <n>   one named account
// node cli/listen.js --all           every account that can listen (D75)
const flags = parseFlags(process.argv.slice(2), ['all', 'json'])

const printEvent = result => console.log(JSON.stringify({ receivedAt: new Date().toISOString(), ...result }))

if (flags.all || flags.account) {
  const supervisor = createSupervisor({
    accountNames: flags.account ? [flags.account] : undefined,
    onClassified: printEvent,
    onError: (name, err) => console.error(`[${name}] listener error: ${err.message}`),
  })
  const connected = await supervisor.start()
  console.error(`team-slack-bridge listener connected for: ${connected.join(', ')}`)
  const shutdown = async () => {
    await supervisor.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} else {
  const { env, config } = loadContext()

  if (!env.SLACK_BOT_TOKEN) {
    console.error('SLACK_BOT_TOKEN not set in .env')
    process.exit(1)
  }
  if (!env.SLACK_APP_TOKEN) {
    console.error('SLACK_APP_TOKEN not set in .env — Socket Mode needs the app-level xapp- token (Basic Information > App-Level Tokens)')
    process.exit(1)
  }
  if (!config.owner?.slackUserId) {
    console.error('No owner configured — run: node cli/setup.js set-owner --user <U0123ABC>')
    process.exit(1)
  }

  const listener = createListener({
    env,
    botToken: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    config,
    configPath: CONFIG_PATH,
    dbPath: LEDGER_PATH,
    homeDir: HOME_DIR,
    onClassified: result => {
      console.log(JSON.stringify({ receivedAt: new Date().toISOString(), ...result }))
    },
    onError: err => {
      console.error(`listener error: ${err.message}`)
    },
  })

  await listener.start()
  console.error('team-slack-bridge listener connected (Socket Mode) — classified events printed to stdout, one per line')

  process.on('SIGINT', async () => {
    await listener.stop()
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    await listener.stop()
    process.exit(0)
  })
}
