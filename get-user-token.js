#!/usr/bin/env node
// One-time helper: runs the Slack OAuth "authorize as user" flow locally,
// then writes the resulting user token straight into .env — it is never
// printed to the terminal or sent anywhere else.
//
// Usage: npm run get-user-token
// Requires SLACK_CLIENT_ID and SLACK_CLIENT_SECRET already set in .env
// (from your app's "Basic Information" page), and the redirect URL below
// registered in your app's OAuth config.
//
// HTTPS, not HTTP (PLAN D55): Slack's public-distribution "Use HTTPS For
// Your Features" check does not exempt localhost redirect URLs, so once an
// app wants Public Distribution, http://localhost:PORT/callback can no
// longer be the registered redirect URL — it has to be https. This script
// auto-generates a local self-signed cert on first run (core/local-tls.js,
// via the system's own openssl, no new dependency) and listens with it. The
// browser will show a one-time "not private" warning for the self-signed
// cert the first time it hits this URL — that's expected; proceed past it.
// To avoid that warning entirely, install mkcert (https://mkcert.dev,
// free) and point SLACK_LOCAL_TLS_CERT/SLACK_LOCAL_TLS_KEY at its output
// instead of letting this script generate its own.

import https from 'node:https'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { loadEnv, ENV_FILE_PATH } from './env.js'
import { loadLocalTlsCert } from './core/local-tls.js'

const PORT = 8917
const REDIRECT_URI = `https://localhost:${PORT}/callback`
const USER_SCOPES = 'chat:write,search:read,im:write,channels:read,groups:read,im:read,mpim:read,files:write,reactions:write,users:read,users:read.email'
const HOME_DIR = process.env.TSB_HOME || join(homedir(), '.team-slack-bridge')

const env = loadEnv()
if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
  console.error('Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in slack/.env first (from Basic Information in your Slack app), then re-run.')
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
  `&user_scope=${encodeURIComponent(USER_SCOPES)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`

console.log('1. Make sure this redirect URL is registered in your Slack app (OAuth & Permissions):')
console.log(`   ${REDIRECT_URI}`)
console.log('2. Open this URL in your browser and approve:')
console.log(`   ${authorizeUrl}`)
console.log('3. Waiting for the redirect back to localhost (your browser will warn about the')
console.log('   self-signed cert on first use unless you configured SLACK_LOCAL_TLS_CERT/KEY —')
console.log('   that warning is expected; proceed past it)...')

function writeUserToken(token) {
  let contents = existsSync(ENV_FILE_PATH) ? readFileSync(ENV_FILE_PATH, 'utf8') : ''
  if (contents.match(/^SLACK_USER_TOKEN=.*$/m)) {
    contents = contents.replace(/^SLACK_USER_TOKEN=.*$/m, `SLACK_USER_TOKEN=${token}`)
  } else {
    contents += `\nSLACK_USER_TOKEN=${token}\n`
  }
  mkdirSync(dirname(ENV_FILE_PATH), { recursive: true })
  writeFileSync(ENV_FILE_PATH, contents, { mode: 0o600 })
  // `{ mode }` above only applies when writeFileSync creates the file — it is
  // silently ignored when overwriting an existing one, so an `.env` that was
  // ever 644 (e.g. from before this protection existed) would stay 644
  // forever without this explicit chmod on every write.
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

  if (!data.ok || !data.authed_user?.access_token) {
    res.writeHead(500).end('OAuth exchange failed — see terminal for details.')
    console.error('OAuth exchange failed:', data.error || 'unknown error')
    server.close()
    return
  }

  writeUserToken(data.authed_user.access_token)
  res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Success — token saved to slack/.env. You can close this tab.')
  console.log(`Done. SLACK_USER_TOKEN written to ${ENV_FILE_PATH} (value not printed here).`)
  server.close()
})

server.listen(PORT)
