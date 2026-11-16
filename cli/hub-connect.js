#!/usr/bin/env node
// node cli/hub-connect.js --url https://hub.example.com --token tsbh_...
// (or TSB_HUB_URL / TSB_HUB_TOKEN in the environment)
//
// Connects THIS machine to a network hub as a host: the hub forwards Slack
// events for you here, and sessions run locally under your own grants.
// Needs SLACK_BOT_TOKEN in this account's .env (to post session output), the
// owner set to your Slack user id, and hub.enabled + agentSessions.enabled.

import { createConnector } from '../core/hub/connector.js'
import { parseFlags } from './lib/args.js'
import { HOME_DIR, loadContext, LEDGER_PATH } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['insecure'])
const hubUrl = flags.url || process.env.TSB_HUB_URL
const hostToken = flags.token || process.env.TSB_HUB_TOKEN
if (!hubUrl || !hostToken) {
  console.error('usage: hub-connect.js --url <hub url> --token <host token>')
  process.exit(1)
}
const { env, config } = loadContext()
if (!env.SLACK_BOT_TOKEN) {
  console.error('SLACK_BOT_TOKEN not set in .env')
  process.exit(1)
}
if (!config.hub?.enabled || !config.agentSessions?.enabled) {
  console.error('Set hub.enabled and agentSessions.enabled in slack-config.json first.')
  process.exit(1)
}

const connector = createConnector({ hubUrl, hostToken, env, config, dbPath: LEDGER_PATH, homeDir: HOME_DIR, allowInsecure: Boolean(flags.insecure) })
await connector.start()
const shutdown = async () => {
  await connector.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
