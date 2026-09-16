// One-time helper: runs the Slack OAuth "authorize as user" flow locally,
// then writes the resulting user token straight into .env — it is never
// printed to the terminal or sent anywhere else.
//
// Usage: npm run get-user-token
// Requires SLACK_CLIENT_ID and SLACK_CLIENT_SECRET already set in .env
// (from your app's "Basic Information" page), and the redirect URL below
// registered in your app's OAuth config.

import http from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadEnv, ENV_FILE_PATH } from './env.js'

const PORT = 8917
const REDIRECT_URI = `http://localhost:${PORT}/callback`
const USER_SCOPES = 'chat:write'

const env = loadEnv()
if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
  console.error('Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in slack/.env first (from Basic Information in your Slack app), then re-run.')
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
console.log('3. Waiting for the redirect back to localhost...')

function writeUserToken(token) {
  let contents = existsSync(ENV_FILE_PATH) ? readFileSync(ENV_FILE_PATH, 'utf8') : ''
  if (contents.match(/^SLACK_USER_TOKEN=.*$/m)) {
    contents = contents.replace(/^SLACK_USER_TOKEN=.*$/m, `SLACK_USER_TOKEN=${token}`)
  } else {
    contents += `\nSLACK_USER_TOKEN=${token}\n`
  }
  mkdirSync(dirname(ENV_FILE_PATH), { recursive: true })
  writeFileSync(ENV_FILE_PATH, contents, { mode: 0o600 })
}

const server = http.createServer(async (req, res) => {
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
