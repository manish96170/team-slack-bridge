#!/usr/bin/env node
// node cli/http.js [--json]
//
// Optional HTTP endpoint for future Slack Events API / slash-command use.
// Disabled unless slack-config.json has http.enabled=true.

import { createHttpServer } from '../listen/http.js'
import { parseFlags } from './lib/args.js'
import { CONFIG_PATH, LEDGER_PATH, loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['json'])
const { env, config } = loadContext()

if (!config.http?.enabled) {
  const result = { ok: false, error: 'http-disabled-in-config', retryable: false }
  if (flags.json) console.log(JSON.stringify(result))
  else console.error(result.error)
  process.exit(1)
}

if ((config.http.verifySlackSignatures !== false || config.slackbotMcp?.enabled) && !env.SLACK_SIGNING_SECRET) {
  const result = { ok: false, error: 'slack-signing-secret-required', retryable: false }
  if (flags.json) console.log(JSON.stringify(result))
  else console.error(result.error)
  process.exit(1)
}

const server = createHttpServer({
  signingSecret: env.SLACK_SIGNING_SECRET,
  env,
  config,
  configPath: CONFIG_PATH,
  dbPath: LEDGER_PATH,
  verifySignatures: config.http.verifySlackSignatures !== false,
  onClassified: result => console.log(JSON.stringify({ receivedAt: new Date().toISOString(), ...result })),
  onError: err => console.error(`http listener error: ${err.message}`),
})

server.listen(config.http.port, () => {
  const result = {
    ok: true,
    listening: true,
    port: config.http.port,
    slackbotMcp: config.slackbotMcp?.enabled ? 'remote profile: locked-down tools.remote.js' : 'disabled',
  }
  if (flags.json) console.log(JSON.stringify(result))
  else console.error(`team-slack-bridge HTTP listener on :${config.http.port} (Slackbot MCP ${result.slackbotMcp})`)
})
