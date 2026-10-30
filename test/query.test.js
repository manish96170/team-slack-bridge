import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tools as localTools } from '../mcp/tools.local.js'
import { tools as remoteTools } from '../mcp/tools.remote.js'
import { validateArguments } from '../mcp/validation.js'
import { classify } from '../core/classify.js'

const emptyConfig = { users: [], watchedChannels: [], owner: {}, remote: { postableChannels: [], readableChannels: [] } }
const env = { SLACK_BOT_TOKEN: 'xoxb-bot', SLACK_USER_TOKEN: 'xoxp-user' }

function mockSlack(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), body: Object.fromEntries(new URLSearchParams(init.body)) })
    const payload = { ok: true, messages: [] }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url,
      headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null), entries: () => [][Symbol.iterator]() },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }
  }
}

async function withMockedSlack(fn) {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = mockSlack(calls)
  try {
    await fn(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('slack_query_messages and slack_get_thread default to the bot token', async () => {
  await withMockedSlack(async calls => {
    await localTools.slack_query_messages.handler({ channel: 'G1' }, { env, config: emptyConfig })
    await localTools.slack_get_thread.handler({ channel: 'G1', threadTs: '1.1' }, { env, config: emptyConfig })
    assert.deepEqual(calls.map(c => c.auth), ['Bearer xoxb-bot', 'Bearer xoxb-bot'])
    assert.ok(calls[0].url.includes('conversations.history'))
    assert.ok(calls[1].url.includes('conversations.replies'))
  })
})

test('asUser:true reads history and threads with the user token', async () => {
  await withMockedSlack(async calls => {
    await localTools.slack_query_messages.handler({ channel: 'G1', asUser: true }, { env, config: emptyConfig })
    await localTools.slack_get_thread.handler({ channel: 'D1', threadTs: '1.1', asUser: true }, { env, config: emptyConfig })
    assert.deepEqual(calls.map(c => c.auth), ['Bearer xoxp-user', 'Bearer xoxp-user'])
  })
})

test('asUser:true without a user token fails closed instead of falling back to the bot', async () => {
  await withMockedSlack(async calls => {
    const result = await localTools.slack_query_messages.handler({ channel: 'G1', asUser: true }, { env: { SLACK_BOT_TOKEN: 'xoxb-bot' }, config: emptyConfig })
    assert.deepEqual(result, { ok: false, error: 'no-token', retryable: false })
    assert.equal(calls.length, 0)
  })
})

test('the remote profile does not advertise or accept asUser on read tools', () => {
  for (const name of ['slack_query_messages', 'slack_get_thread']) {
    assert.ok(localTools[name].inputSchema.properties.asUser)
    assert.equal(remoteTools[name].inputSchema.properties.asUser, undefined)
    const args = name === 'slack_get_thread' ? { channel: 'C1', threadTs: '1.1', asUser: true } : { channel: 'C1', asUser: true }
    assert.equal(validateArguments(remoteTools[name].inputSchema, args), 'unknown argument: asUser')
  }
})

test('manifest and user-token OAuth request every history scope for bot and user, plus message.mpim', () => {
  const manifest = JSON.parse(readFileSync(new URL('../config/slack-app-manifest.template.json', import.meta.url), 'utf8'))
  const history = ['channels:history', 'groups:history', 'im:history', 'mpim:history']
  for (const scope of history) {
    assert.ok(manifest.oauth_config.scopes.bot.includes(scope), `bot ${scope}`)
    assert.ok(manifest.oauth_config.scopes.user.includes(scope), `user ${scope}`)
  }
  assert.ok(manifest.settings.event_subscriptions.bot_events.includes('message.mpim'))
  const userScopes = readFileSync(new URL('../get-user-token.js', import.meta.url), 'utf8').match(/USER_SCOPES = '([^']+)'/)[1].split(',')
  for (const scope of history) assert.ok(userScopes.includes(scope), `get-user-token ${scope}`)
})

test('group-DM message events are ignored by the classifier (history access never triggers actions)', () => {
  const result = classify({ type: 'message', channel_type: 'mpim', user: 'U_OWNER', text: 'srn' }, { owner: { slackUserId: 'U_OWNER' } })
  assert.equal(result.kind, 'ignore')
})
