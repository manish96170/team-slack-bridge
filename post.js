#!/usr/bin/env node
// Post a message to Slack — as the bot (default) or as your own user
// identity (--as-user), and to a channel or as a DM (--dm).
//
// Usage:
//   node post.js --text "build finished" --channel "#your-channel-name"
//   node post.js --text "reminder to self" --dm U0123ABC --as-user
//
// This is the outbound piece only — it does not read/listen to Slack.
// Inbound (mentions, DM listening) is a separate, not-yet-built concern.

import { loadEnv } from './env.js'

const env = loadEnv()

function parseArgs(argv) {
  const args = { asUser: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--as-user') args.asUser = true
    else if (a === '--text') args.text = argv[++i]
    else if (a === '--channel') args.channel = argv[++i]
    else if (a === '--dm') args.dm = argv[++i]
  }
  return args
}

async function slackCall(method, token, body) {
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  })
  const data = await resp.json()
  if (!data.ok) throw new Error(`Slack API ${method} failed: ${data.error}`)
  return data
}

async function resolveDmChannel(botToken, userId) {
  const { channel } = await slackCall('conversations.open', botToken, { users: userId })
  return channel.id
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.text) throw new Error('--text is required')
  if (!args.channel && !args.dm) throw new Error('one of --channel or --dm is required')

  const token = args.asUser ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN
  if (!token) {
    throw new Error(
      args.asUser
        ? 'SLACK_USER_TOKEN not set — run `npm run get-user-token` first.'
        : 'SLACK_BOT_TOKEN not set in slack/.env.'
    )
  }

  let channel = args.channel
  if (args.dm) {
    // conversations.open must always use the bot token, even when the
    // message itself will be sent as the user.
    if (!env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN required to resolve a DM channel.')
    channel = await resolveDmChannel(env.SLACK_BOT_TOKEN, args.dm)
  }

  await slackCall('chat.postMessage', token, { channel, text: args.text })
  console.log(`Posted ${args.asUser ? 'as user' : 'as bot'} to ${args.dm ? `DM ${args.dm}` : channel}.`)
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
