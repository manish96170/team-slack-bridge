// One-time helper: runs the Slack OAuth "install to a workspace" flow
// locally, then writes the resulting BOT token (and team_id) into THIS
// install's .env — never printed to the terminal or sent anywhere else.
//
// Use this to install the app into a NEW workspace without needing a
// public HTTPS endpoint or Slack admin "org-wide deploy" access (PLAN D54/
// D55) — e.g. right after `node cli/tenants.js add <teamId>`, run this with
// TSB_HOME pointed at the printed tenant home dir:
//
//   node cli/tenants.js add TACME
//   TSB_HOME=~/.team-slack-bridge/tenants/TACME node get-workspace-token.js
//
// Requires SLACK_CLIENT_ID and SLACK_CLIENT_SECRET already set in THIS
// install's .env (same values as the main install — the app's client
// credentials are per-app, not per-workspace, see PLAN D54's note on
// Slack's signing secret being per-app for the same reason), and Public
// Distribution activated on the app (api.slack.com/apps -> Manage
// Distribution) so a workspace other than the app's home workspace is
// allowed to authorize it at all.
//
// Same HTTPS-via-self-signed-cert approach as get-user-token.js (PLAN
// D55) — see that file's header for why plain HTTP no longer works here
// once Public Distribution is on.

import https from 'node:https'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { loadEnv, ENV_FILE_PATH } from './env.js'
import { loadLocalTlsCert } from './core/local-tls.js'

const PORT = 8917
const REDIRECT_URI = `https://localhost:${PORT}/callback`
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const HOME_DIR = process.env.TSB_HOME || join(homedir(), '.team-slack-bridge')

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'config/slack-app-manifest.template.json'), 'utf8'))
const BOT_SCOPES = manifest.oauth_config.scopes.bot.join(',')

const env = loadEnv()
if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
  console.error('Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in .env first (same values as your main install — these are per-app, not per-workspace), then re-run.')
  process.exit(1)
}

function loadTlsOptions() {
  if (env.SLACK_LOCAL_TLS_CERT && env.SLACK_LOCAL_TLS_KEY) {
    return { ok: true, cert: readFileSync(env.SLACK_LOCAL_TLS_CERT), key: readFileSync(env.SLACK_LOCAL_TLS_KEY) }
  }
  return loadLocalTlsCert(HOME_DIR)
}

const tls = loadTlsOptions()
if (!tls.ok) {
  console.error(`Could not set up a local HTTPS listener: ${tls.error}`)
  if (tls.detail) console.error(tls.detail)
  process.exit(1)
}

const authorizeUrl =
  `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(env.SLACK_CLIENT_ID)}` +
  `&scope=${encodeURIComponent(BOT_SCOPES)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`

console.log('1. Make sure this redirect URL is registered in the app\'s OAuth & Permissions, and')
console.log('   Public Distribution is activated (Manage Distribution):')
console.log(`   ${REDIRECT_URI}`)
console.log('2. Open this URL IN A BROWSER LOGGED INTO THE TARGET WORKSPACE and approve:')
console.log(`   ${authorizeUrl}`)
console.log('3. Waiting for the redirect back to localhost (one-time self-signed-cert browser')
console.log('   warning expected unless SLACK_LOCAL_TLS_CERT/KEY is set — proceed past it)...')

function writeBotToken(token) {
  let contents = existsSync(ENV_FILE_PATH) ? readFileSync(ENV_FILE_PATH, 'utf8') : ''
  if (contents.match(/^SLACK_BOT_TOKEN=.*$/m)) {
    contents = contents.replace(/^SLACK_BOT_TOKEN=.*$/m, `SLACK_BOT_TOKEN=${token}`)
  } else {
    contents += `\nSLACK_BOT_TOKEN=${token}\n`
  }
  mkdirSync(dirname(ENV_FILE_PATH), { recursive: true })
  writeFileSync(ENV_FILE_PATH, contents, { mode: 0o600 })
  chmodSync(ENV_FILE_PATH, 0o600)
}

const server = https.createServer({ cert: tls.cert, key: tls.key }, async (req, res) => {
  if (!req.url.startsWith('/callback')) {
    res.writeHead(404).end()
    return
  }
  const url = new URL(req.url, REDIRECT_URI)
  const code = url.searchParams.get('code')
  if (!code) {
    res.writeHead(400).end('Missing code param')
    return
  }

  const resp = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  })
  const data = await resp.json()

  if (!data.ok || !data.access_token) {
    res.writeHead(500).end('OAuth exchange failed — see terminal for details.')
    console.error('OAuth exchange failed:', data.error || 'unknown error')
    server.close()
    return
  }

  writeBotToken(data.access_token)
  res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`Installed to ${data.team?.name || data.team?.id} — token saved. You can close this tab.`)
  // team_id/team name are not secret (visible in Slack's own UI to anyone
  // in that workspace) — only the token itself is withheld from the log.
  console.log(`Done. SLACK_BOT_TOKEN written to ${ENV_FILE_PATH} for team ${data.team?.name || ''} (${data.team?.id}).`)
  console.log(`Confirm this team_id matches what you passed to "node cli/tenants.js add" for this home dir.`)
  server.close()
})

server.listen(PORT)
