// App Home tab (added on request, 2026-09-09): a point-wise feature guide
// published to `views.publish` so anyone who installs the app sees what it
// can do without reading this repo's README. Same shape as everything
// else — a plain function, token as a parameter, --dry-run support.
//
// Requires the Slack app's manifest to have `features.app_home.home_tab_enabled: true`
// (see config/slack-app-manifest.template.json) — without that, `views.publish`
// fails with `not_enabled`.

import { callSlack } from './slack.js'

const FEATURES = [
  { emoji: '📤', title: 'Post & reply', detail: 'Post to a channel or reply in a thread as the bot — `@handle` in the text becomes a real, notifying mention if that person is in `slack-config.json`.' },
  { emoji: '✏️', title: 'Edit & react', detail: 'Update or delete a message this install posted, or react with an emoji — good for a status message that edits itself instead of posting six times.' },
  { emoji: '⏱️', title: 'Schedule a message', detail: 'Post something up to 120 days in the future, and cancel it before it goes out if plans change.' },
  { emoji: '💬', title: 'DM', detail: 'The bot can DM a specific person directly.' },
  { emoji: '🙋', title: 'Ask & approve', detail: 'An agent session can DM a question straight to its owner and wait for a reply — free text, or Approve/Deny buttons — before continuing.' },
  { emoji: '📈', title: 'Progress updates', detail: 'A long task can post one message and keep updating it in place (started → running → done/failed) instead of spamming a channel.' },
  { emoji: '🔎', title: 'Read history & threads', detail: 'Pull recent channel messages or a whole thread back into an agent session.' },
  { emoji: '🩺', title: 'Health check', detail: 'One command reports whether tokens are valid and which configured channels the bot can actually reach — never prints a token value.' },
]

function buildHomeView() {
  return {
    type: 'home',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'team-slack-bridge', emoji: true } },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'A Slack bridge for AI agent sessions (Claude Code, OpenCode, etc.) and anyone else scripting against Slack. Here is what it can do:' },
      },
      { type: 'divider' },
      ...FEATURES.flatMap(f => [
        { type: 'section', text: { type: 'mrkdwn', text: `${f.emoji} *${f.title}*\n${f.detail}` } },
      ]),
      { type: 'divider' },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Full setup guide and CLI reference: this app\'s repo README.md. Ask whoever installed it for access.' }],
      },
    ],
  }
}

export async function publishHome({ token, userId, dryRun }) {
  if (!userId) return { ok: false, error: 'userId-required', retryable: false }
  const view = buildHomeView()
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'views.publish', body: { user_id: userId, view } } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return callSlack('views.publish', token, { user_id: userId, view })
}
