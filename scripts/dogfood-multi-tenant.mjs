#!/usr/bin/env node
// Multi-tenancy live dogfood (ROADMAP.md's step 3, PLAN D53/D54).
//
// Proves real isolation with REAL Slack credentials: two already-provisioned
// tenants (via `node cli/tenants.js add`, each with its own real bot token in
// its own home dir's .env) are each asked `slack_doctor` through ONE shared
// local /mcp endpoint running in tenancyMode:"multi". slack_doctor calls
// Slack's real `auth.test` with whichever bot token resolveAccount() handed
// it -- so a correct result is a live Slack API call confirming each
// request landed on the right real workspace, not just a local assertion.
//
// This does NOT require a public HTTPS endpoint or Slack admin approval --
// it drives the HTTP layer directly over 127.0.0.1 with real HMAC-signed
// requests, the same signature check /mcp always performs. The one thing it
// deliberately does NOT prove is "Slack's own Slackbot MCP Client can reach
// us over the internet" -- that needs a public URL and workspace admin
// approval, both manual, both outside what a script run locally can verify.
//
// Required env vars (never pass real secrets as CLI args -- they end up in
// shell history):
//   DOGFOOD_TEAM_A=<team_id already added via cli/tenants.js>
//   DOGFOOD_TEAM_B=<a second, different team_id, also already added>
// Everything else (SLACK_SIGNING_SECRET, each tenant's own bot token) is
// read from .env files already on disk, never typed into this script or any
// chat.

import { createHmac } from 'node:crypto'
import { createHttpServer } from '../listen/http.js'
import { loadContext } from '../cli/context.js'

function fail(message) {
  console.error(`DOGFOOD FAILED: ${message}`)
  process.exit(1)
}

const teamA = process.env.DOGFOOD_TEAM_A
const teamB = process.env.DOGFOOD_TEAM_B
if (!teamA || !teamB) fail('set DOGFOOD_TEAM_A and DOGFOOD_TEAM_B to two already-provisioned team_ids')
if (teamA === teamB) fail('DOGFOOD_TEAM_A and DOGFOOD_TEAM_B must be two DIFFERENT team_ids')

const { env } = loadContext()
if (!env.SLACK_SIGNING_SECRET) {
  fail('top-level .env has no SLACK_SIGNING_SECRET -- /mcp always requires one. Add it from the Slack app\'s Basic Information page (manual, do not paste it to anyone) and re-run.')
}

const config = {
  slackbotMcp: { enabled: true, authType: 'slack_identity_auth', tenancy: { mode: 'multi' } },
}

function sign(body, timestamp) {
  return `v0=${createHmac('sha256', env.SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`
}

async function callDoctor(port, teamId) {
  const message = {
    jsonrpc: '2.0',
    id: teamId,
    method: 'tools/call',
    params: { name: 'slack_doctor', arguments: {}, _meta: { slack: { user_id: 'U0DOGFOOD', team_id: teamId, enterprise_id: null } } },
  }
  const body = JSON.stringify(message)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': sign(body, timestamp),
    },
    body,
  })
  const json = await res.json()
  if (json.error) return { ok: false, error: json.error.message }
  const parsed = JSON.parse(json.result.content[0].text)
  return { ok: !json.result.isError, ...parsed }
}

async function main() {
  const server = createHttpServer({ signingSecret: env.SLACK_SIGNING_SECRET, env, config, dbPath: '', verifySignatures: true })
  await new Promise(resolve => server.listen(0, resolve))
  const port = server.address().port

  try {
    console.log(`Local /mcp listening on 127.0.0.1:${port}, tenancyMode:"multi"\n`)

    const resultA = await callDoctor(port, teamA)
    const resultB = await callDoctor(port, teamB)

    console.log(`Team A (${teamA}): ${JSON.stringify(resultA.botAuth || resultA)}`)
    console.log(`Team B (${teamB}): ${JSON.stringify(resultB.botAuth || resultB)}`)

    if (!resultA.ok) fail(`Team A call failed: ${JSON.stringify(resultA)}`)
    if (!resultB.ok) fail(`Team B call failed: ${JSON.stringify(resultB)}`)
    if (!resultA.botAuth?.ok || !resultB.botAuth?.ok) fail('one tenant has no working SLACK_BOT_TOKEN -- re-run cli/setup.js init for that tenant\'s home dir')
    if (resultA.botAuth.team === resultB.botAuth.team && resultA.botAuth.user === resultB.botAuth.user) {
      fail('both team_ids resolved to the SAME real Slack identity -- tenant isolation is broken, do not ship this')
    }

    console.log('\nPASS: two different team_ids resolved to two different real Slack identities through one shared /mcp endpoint.')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(err => fail(err.stack || err.message))
