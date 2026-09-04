// Diagnostic only — proves the bot can read DM history via im:read/im:history.
// Not the real inbound listener (that's a separate, not-yet-built piece).
//
// Usage: node verify-dm.js

import { loadEnv } from './env.js'

const env = loadEnv()
if (!env.SLACK_BOT_TOKEN) {
  console.error('SLACK_BOT_TOKEN not set in .env')
  process.exit(1)
}

async function slackCall(method, params) {
  // form-encoded, not JSON — conversations.list silently ignores the `types`
  // filter (and other params) when sent as a JSON body.
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  })
  const data = await resp.json()
  if (!data.ok) throw new Error(`${method} failed: ${data.error}`)
  return data
}

const { channels } = await slackCall('conversations.list', { types: 'im', limit: 50 })
if (!channels.length) {
  console.log('No DM channels found — the bot has no open IM conversations yet.')
  process.exit(0)
}

for (const ch of channels) {
  console.log(`\nDM channel ${ch.id} (with user ${ch.user}):`)
  let messages
  try {
    ;({ messages } = await slackCall('conversations.history', { channel: ch.id, limit: 5 }))
  } catch (err) {
    // Slackbot's own DM (and possibly other special conversations) isn't
    // readable this way — not a config problem, just skip it.
    console.log(`  (unreadable: ${err.message})`)
    continue
  }
  if (!messages.length) {
    console.log('  (no messages visible)')
    continue
  }
  for (const m of messages.reverse()) {
    console.log(`  [${m.user || 'bot'}] ${m.text}`)
  }
}
