import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getReactions, listReactions } from '../core/reactions.js'
import { tools } from '../mcp/tools.local.js'
import { tools as remoteTools } from '../mcp/tools.remote.js'
import { validateArguments } from '../mcp/validation.js'

function fakeSlack(responses = {}) {
  const calls = []
  const slackCall = async (method, token, body = {}) => {
    calls.push({ method, token, body })
    const handler = responses[method]
    return handler ? handler(body) : { ok: true }
  }
  return { calls, slackCall }
}

const REACTIONS = [
  { name: 'white_check_mark', count: 2, users: ['U1', 'U2'] },
  { name: 'eyes', count: 1, users: ['U3'] },
  { name: '+1::skin-tone-3', count: 1, users: ['U4'] },
]

test('getReactions returns who reacted with what, with full user lists', async () => {
  const { calls, slackCall } = fakeSlack({ 'reactions.get': () => ({ ok: true, type: 'message', channel: 'C1', message: { ts: '1.1', reactions: REACTIONS } }) })
  const result = await getReactions({ token: 'xoxp', channel: 'C1', ts: '1.1', slackCall })
  assert.equal(result.ok, true)
  assert.deepEqual(result.reactions.map(reaction => [reaction.name, reaction.count, reaction.users]), [
    ['white_check_mark', 2, ['U1', 'U2']],
    ['eyes', 1, ['U3']],
    ['+1::skin-tone-3', 1, ['U4']],
  ])
  assert.deepEqual(calls[0], { method: 'reactions.get', token: 'xoxp', body: { channel: 'C1', timestamp: '1.1', full: 'true' } })
})

test('getReactions filters by emoji (colons and skin-tone suffixes tolerated) and handles a message with no reactions', async () => {
  const { slackCall } = fakeSlack({ 'reactions.get': () => ({ ok: true, message: { ts: '1.1', reactions: REACTIONS } }) })
  assert.deepEqual((await getReactions({ token: 't', channel: 'C1', ts: '1.1', emoji: ':white_check_mark:', slackCall })).reactions.map(r => r.name), ['white_check_mark'])
  assert.deepEqual((await getReactions({ token: 't', channel: 'C1', ts: '1.1', emoji: '+1', slackCall })).reactions.map(r => r.name), ['+1::skin-tone-3'])
  assert.deepEqual((await getReactions({ token: 't', channel: 'C1', ts: '1.1', emoji: 'tada', slackCall })).reactions, [])
  const none = fakeSlack({ 'reactions.get': () => ({ ok: true, message: { ts: '1.1' } }) })
  assert.deepEqual((await getReactions({ token: 't', channel: 'C1', ts: '1.1', slackCall: none.slackCall })).reactions, [])
})

test('getReactions validates input and passes Slack errors through untouched', async () => {
  const failing = fakeSlack({ 'reactions.get': () => ({ ok: false, error: 'missing_scope', retryable: false }) })
  assert.equal((await getReactions({ token: 't', channel: 'C1', slackCall: failing.slackCall })).error, 'channel-and-ts-required')
  assert.equal((await getReactions({ channel: 'C1', ts: '1.1', slackCall: failing.slackCall })).error, 'no-token')
  assert.deepEqual(await getReactions({ token: 't', channel: 'C1', ts: '1.1', slackCall: failing.slackCall }), { ok: false, error: 'missing_scope', retryable: false })
})

test('listReactions reports messages only, truncates text, clamps count, filters by emoji and returns the cursor', async () => {
  const items = [
    { type: 'message', channel: 'C1', message: { ts: '1.1', text: 'x'.repeat(500), reactions: [REACTIONS[0]] } },
    { type: 'message', channel: 'C2', message: { ts: '2.2', text: 'second', reactions: [REACTIONS[1]] } },
    { type: 'file', channel: 'C3', file: { id: 'F1' } },
  ]
  const { calls, slackCall } = fakeSlack({ 'reactions.list': () => ({ ok: true, items, response_metadata: { next_cursor: 'abc' } }) })
  const all = await listReactions({ token: 't', userId: 'U9', count: 500, cursor: 'prev', slackCall })
  assert.deepEqual(calls[0].body, { full: 'true', count: '100', user: 'U9', cursor: 'prev' })
  assert.equal(all.items.length, 2, 'file items are dropped')
  assert.equal(all.items[0].text.length, 200)
  assert.equal(all.nextCursor, 'abc')
  const checks = await listReactions({ token: 't', emoji: 'white_check_mark', slackCall })
  assert.deepEqual(checks.items.map(item => item.ts), ['1.1'])
  assert.equal((await listReactions({ slackCall })).error, 'no-token')
})

test('slack_reactions tool: registered locally only, validated, token source echoed and explicit', async () => {
  assert.ok(tools.slack_reactions)
  assert.equal(remoteTools.slack_reactions, undefined)
  assert.equal(validateArguments(tools.slack_reactions.inputSchema, { action: 'nope' }), 'action must be one of: get, list')
  assert.equal(validateArguments(tools.slack_reactions.inputSchema, { action: 'get', link: 'https://x.slack.com/archives/C1/p1793337025613279' }), null)
  assert.equal(validateArguments(tools.slack_reactions.inputSchema, { action: 'get', channel: 'C1', ts: '1.1', viaBot: true }), 'unknown argument: viaBot')

  const none = { env: {}, config: {}, dbPath: undefined }
  const human = await tools.slack_reactions.handler({ action: 'get', channel: 'C1', ts: '1.1' }, none)
  assert.deepEqual([human.error, human.tokenSource], ['no-token', 'user'])
  const bot = await tools.slack_reactions.handler({ action: 'list', tokenSource: 'bot' }, none)
  assert.deepEqual([bot.error, bot.tokenSource], ['no-token', 'bot'])
  const noTs = await tools.slack_reactions.handler({ action: 'get', channel: 'C1' }, { env: { SLACK_USER_TOKEN: 'xoxp' }, config: {}, dbPath: undefined })
  assert.equal(noTs.error, 'channel-and-ts-required')
})

test('slack_reactions resolves a message permalink into channel + ts before calling Slack', async () => {
  const result = await tools.slack_reactions.handler(
    { action: 'get', link: 'https://x.slack.com/archives/C0123ABCD/p1793337025613279' },
    { env: {}, config: {}, dbPath: undefined }
  )
  assert.equal(result.error, 'no-token', 'reached the Slack layer, i.e. channel and ts were resolved from the link')
})

test('reactions:read is requested for both the user and bot tokens', () => {
  const manifest = JSON.parse(readFileSync(new URL('../config/slack-app-manifest.template.json', import.meta.url), 'utf8'))
  const userScopes = readFileSync(new URL('../get-user-token.js', import.meta.url), 'utf8').match(/USER_SCOPES = '([^']+)'/)[1].split(',')
  assert.ok(manifest.oauth_config.scopes.user.includes('reactions:read'))
  assert.ok(manifest.oauth_config.scopes.bot.includes('reactions:read'))
  assert.ok(userScopes.includes('reactions:read'))
  assert.equal(new Set(manifest.oauth_config.scopes.bot).size, manifest.oauth_config.scopes.bot.length)
})
