import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { messageGroupByName, createGroupByName, setGroupTopic } from '../core/mpim.js'
import { clearDirectoryCache } from '../core/directory.js'

const SELF = { id: 'U0SELF001', name: 'me', real_name: 'Me' }
const SHRESTHA = { id: 'U0SHRE001', name: 'shrestha', real_name: 'Shrestha Srivastava', profile: { display_name: 'Shrestha Srivastava' } }
const ALEX = { id: 'U0ALEX001', name: 'alex', real_name: 'Alex Doe', profile: { display_name: 'Alex Doe' } }

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-mpim-'))
  clearDirectoryCache()
  return Promise.resolve()
    .then(() => fn(join(dir, '.ledger.sqlite')))
    .finally(() => {
      clearDirectoryCache()
      rmSync(dir, { recursive: true, force: true })
    })
}

function transport({ mpims = [{ id: 'G0EXIST', members: [SELF.id, SHRESTHA.id, ALEX.id] }] } = {}) {
  const calls = []
  const slackCall = async (method, token, body = {}) => {
    calls.push({ method, token, body })
    if (method === 'auth.test') return { ok: true, team_id: 'T0EXAMPLE', user_id: SELF.id, team: 'Example' }
    if (method === 'users.list') return { ok: true, members: [SELF, SHRESTHA, ALEX], response_metadata: {} }
    if (method === 'users.conversations') return { ok: true, channels: mpims.map(({ id }) => ({ id, is_mpim: true })), response_metadata: {} }
    if (method === 'conversations.members') return { ok: true, members: mpims.find(group => group.id === body.channel)?.members || [] }
    if (method === 'chat.postMessage') return { ok: true, channel: body.channel, ts: '1.1' }
    return { ok: false, error: 'unexpected-method' }
  }
  return { calls, slackCall }
}

test('messageGroupByName resolves two named recipients, finds an existing exact MPIM, and sends only with the user token', async () =>
  withTempDb(async dbPath => {
    const { calls, slackCall } = transport()
    const result = await messageGroupByName({
      peopleNames: ['Shrestha Srivastava', 'Alex Doe'],
      text: 'hi',
      confirm: true,
      userToken: 'xoxp-authorized-human',
      dbPath,
      slackCall,
    })
    assert.equal(result.ok, true)
    assert.equal(result.conversationId, 'G0EXIST')
    assert.equal(result.asUser, true)
    assert.equal(calls.filter(call => call.method === 'chat.postMessage').length, 1)
    assert.equal(calls.find(call => call.method === 'chat.postMessage').token, 'xoxp-authorized-human')
    assert.equal(calls.find(call => call.method === 'chat.postMessage').body.channel, 'G0EXIST')
    assert.ok(!calls.some(call => call.method === 'conversations.open'), 'MPIM messaging must never create/open a group implicitly')
  }))

test('messageGroupByName indexes people and exact MPIM membership so a later identical send stays local until chat.postMessage', async () =>
  withTempDb(async dbPath => {
    const first = transport()
    await messageGroupByName({ peopleNames: ['Shrestha Srivastava', 'Alex Doe'], text: 'first', confirm: true, userToken: 'xoxp-authorized-human', dbPath, slackCall: first.slackCall })
    const second = transport()
    const result = await messageGroupByName({ peopleNames: ['Shrestha Srivastava', 'Alex Doe'], text: 'second', confirm: true, userToken: 'xoxp-authorized-human', dbPath, slackCall: second.slackCall })
    assert.equal(result.ok, true)
    assert.deepEqual(second.calls.map(call => call.method), ['auth.test', 'chat.postMessage'])
  }))

test('persistent directory cache preserves ambiguous-user refusal instead of selecting one cached name match', async () =>
  withTempDb(async dbPath => {
    clearDirectoryCache('xoxp-authorized-human')
    const AJAY_A = { id: 'U0AJAYA01', name: 'ajay.a', real_name: 'Ajay Kumar', profile: { display_name: 'Ajay Kumar' } }
    const AJAY_B = { id: 'U0AJAYB01', name: 'ajay.b', real_name: 'Ajay Kumar', profile: { display_name: 'Ajay Kumar' } }
    const { calls, slackCall } = transport()
    const original = slackCall
    const duplicateDirectory = async (method, token, body) => {
      if (method === 'users.list') return { ok: true, members: [SELF, AJAY_A, AJAY_B, ALEX], response_metadata: {} }
      return original(method, token, body)
    }
    const first = await messageGroupByName({ peopleNames: ['Ajay Kumar', 'Alex Doe'], text: 'hi', userToken: 'xoxp-authorized-human', dbPath, slackCall: duplicateDirectory })
    assert.equal(first.ok, false)
    assert.equal(first.error, 'ambiguous-user')
    const listCallsAfterFirst = calls.filter(call => call.method === 'users.list').length
    const second = await messageGroupByName({ peopleNames: ['Ajay Kumar', 'Alex Doe'], text: 'hi', userToken: 'xoxp-authorized-human', dbPath, slackCall: duplicateDirectory })
    assert.equal(second.ok, false)
    assert.equal(second.error, 'ambiguous-user')
    assert.equal(calls.filter(call => call.method === 'users.list').length, listCallsAfterFirst, 'complete persistent snapshot should preserve ambiguity without another Slack walk')
  }))

test('messageGroupByName asks before creating anything when no exact existing MPIM exists', async () =>
  withTempDb(async dbPath => {
    const { calls, slackCall } = transport({ mpims: [] })
    const result = await messageGroupByName({ peopleNames: ['Shrestha Srivastava', 'Alex Doe'], text: 'hi', userToken: 'xoxp-authorized-human', dbPath, slackCall })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'mpim-not-found-confirm-create-first')
    assert.ok(!calls.some(call => call.method === 'chat.postMessage'))
    assert.ok(!calls.some(call => call.method === 'conversations.open'))
  }))

test('messageGroupByName dry-run performs safe reads but sends nothing and creates no database file', async () =>
  withTempDb(async dbPath => {
    const { calls, slackCall } = transport()
    const result = await messageGroupByName({ peopleNames: ['Shrestha Srivastava', 'Alex Doe'], text: 'hi', userToken: 'xoxp-authorized-human', dbPath, dryRun: true, slackCall })
    assert.equal(result.ok, true)
    assert.equal(result.dryRun, true)
    assert.equal(result.request.body.channel, 'G0EXIST')
    assert.ok(!calls.some(call => call.method === 'chat.postMessage'))
    assert.equal(existsSync(dbPath), false)
  }))

test('messageGroupByName requires at least two other recipients and never bot-falls-back without a user token', async () => {
  const one = await messageGroupByName({ peopleNames: ['Shrestha Srivastava'], text: 'hi', userToken: 'xoxp-authorized-human', slackCall: async () => { throw new Error('not called') } })
  assert.deepEqual(one, { ok: false, error: 'at-least-two-mpim-recipients-required', retryable: false })
  const missing = await messageGroupByName({ peopleNames: ['Shrestha Srivastava', 'Alex Doe'], text: 'hi' })
  assert.deepEqual(missing, { ok: false, error: 'user-token-required', retryable: false })
})

function createTransport({ mpims = [], openError, alreadyOpen } = {}) {
  const base = transport({ mpims })
  const slackCall = async (method, token, body = {}) => {
    if (method === 'conversations.open') {
      base.calls.push({ method, token, body })
      return openError ? { ok: false, error: openError } : { ok: true, channel: { id: 'G0NEW001' }, ...(alreadyOpen ? { already_open: true } : {}) }
    }
    if (method === 'conversations.setTopic') {
      base.calls.push({ method, token, body })
      return { ok: true, topic: body.topic }
    }
    if (method === 'conversations.info') {
      base.calls.push({ method, token, body })
      return body.channel.startsWith('G0') ? { ok: true, channel: { id: body.channel, is_mpim: body.channel === 'G0MPIM' } } : { ok: false, error: 'channel_not_found' }
    }
    return base.slackCall(method, token, body)
  }
  return { calls: base.calls, slackCall }
}

const PEOPLE = ['Shrestha Srivastava', 'Alex Doe']

test('createGroupByName refuses without confirm:true and opens nothing, listing who would be included', async () =>
  withTempDb(async dbPath => {
    const { calls, slackCall } = createTransport()
    const result = await createGroupByName({ peopleNames: PEOPLE, topic: 'Sync', text: 'first', userToken: 'xoxp-authorized-human', dbPath, slackCall })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'confirm-required-to-create-group-dm')
    assert.equal(result.topic, 'Sync')
    assert.equal(result.text, 'first')
    assert.deepEqual(result.recipients.map(r => r.id).sort(), [SHRESTHA.id, ALEX.id].sort())
    assert.ok(!calls.some(call => call.method === 'conversations.open'))
  }))

test('createGroupByName with confirm:true opens the group with the user token, sets the topic, sends the first message and caches it', async () =>
  withTempDb(async dbPath => {
    const { calls, slackCall } = createTransport()
    const created = await createGroupByName({ peopleNames: PEOPLE, topic: 'Release sync', text: 'hello', confirm: true, userToken: 'xoxp-authorized-human', dbPath, slackCall })
    assert.equal(created.ok, true)
    assert.equal(created.created, true)
    assert.equal(created.conversationId, 'G0NEW001')
    assert.equal(created.topicApplied, true)
    assert.equal(created.textSent, true)
    const open = calls.find(call => call.method === 'conversations.open')
    assert.equal(open.token, 'xoxp-authorized-human')
    assert.deepEqual(open.body.users.split(',').sort(), [SHRESTHA.id, ALEX.id].sort())
    assert.deepEqual(calls.find(call => call.method === 'conversations.setTopic').body, { channel: 'G0NEW001', topic: 'Release sync' })
    assert.equal(calls.find(call => call.method === 'chat.postMessage').body.channel, 'G0NEW001')
    // The new group is now an "existing" one for later by-name messaging, with no listing needed.
    const later = createTransport({ mpims: [] })
    const sent = await messageGroupByName({ peopleNames: PEOPLE, text: 'again', confirm: true, userToken: 'xoxp-authorized-human', dbPath, slackCall: later.slackCall })
    assert.equal(sent.ok, true)
    assert.equal(sent.conversationId, 'G0NEW001')
  }))

test('createGroupByName never touches an already-existing exact group', async () =>
  withTempDb(async dbPath => {
    const { calls, slackCall } = createTransport({ mpims: [{ id: 'G0EXIST', members: [SELF.id, SHRESTHA.id, ALEX.id] }] })
    const result = await createGroupByName({ peopleNames: PEOPLE, topic: 'New topic', text: 'hi', confirm: true, userToken: 'xoxp-authorized-human', dbPath, slackCall })
    assert.equal(result.ok, true)
    assert.equal(result.created, false)
    assert.equal(result.conversationId, 'G0EXIST')
    assert.equal(result.topicApplied, false)
    assert.equal(result.textSent, false)
    assert.ok(!calls.some(call => ['conversations.open', 'conversations.setTopic', 'chat.postMessage'].includes(call.method)))
  }))

test('createGroupByName leaves a group untouched when conversations.open reports it already existed (race or stale index)', async () =>
  withTempDb(async dbPath => {
    const { calls, slackCall } = createTransport({ alreadyOpen: true })
    const result = await createGroupByName({ peopleNames: PEOPLE, topic: 'New', text: 'hi', confirm: true, userToken: 'xoxp-authorized-human', dbPath, slackCall })
    assert.equal(result.ok, true)
    assert.equal(result.created, false)
    assert.equal(result.existing, true)
    assert.equal(result.topicApplied, false)
    assert.equal(result.textSent, false)
    assert.ok(!calls.some(call => ['conversations.setTopic', 'chat.postMessage'].includes(call.method)))
  }))

test('createGroupByName dry-run previews conversations.open, writes nothing and creates no database file', async () =>
  withTempDb(async dbPath => {
    const { calls, slackCall } = createTransport()
    const result = await createGroupByName({ peopleNames: PEOPLE, confirm: true, dryRun: true, userToken: 'xoxp-authorized-human', dbPath, slackCall })
    assert.equal(result.ok, true)
    assert.equal(result.dryRun, true)
    assert.equal(result.request.method, 'conversations.open')
    assert.ok(!calls.some(call => call.method === 'conversations.open'))
    assert.equal(existsSync(dbPath), false)
  }))

test('createGroupByName reports a Slack open failure (e.g. missing_scope) and validates inputs without calling Slack', async () =>
  withTempDb(async dbPath => {
    const failing = createTransport({ openError: 'missing_scope' })
    const failed = await createGroupByName({ peopleNames: PEOPLE, confirm: true, userToken: 'xoxp-authorized-human', dbPath, slackCall: failing.slackCall })
    assert.equal(failed.ok, false)
    assert.equal(failed.error, 'missing_scope')
    const never = async () => { throw new Error('not called') }
    assert.equal((await createGroupByName({ peopleNames: ['Only One'], confirm: true, userToken: 'x', slackCall: never })).error, 'at-least-two-mpim-recipients-required')
    assert.equal((await createGroupByName({ peopleNames: Array.from({ length: 9 }, (_, i) => `P${i}`), confirm: true, userToken: 'x', slackCall: never })).error, 'too-many-mpim-recipients')
    assert.equal((await createGroupByName({ peopleNames: PEOPLE, confirm: true, slackCall: never })).error, 'user-token-required')
    assert.equal((await createGroupByName({ peopleNames: PEOPLE, topic: 'x'.repeat(251), confirm: true, userToken: 'x', slackCall: never })).error, 'invalid-topic')
  }))

test('setGroupTopic only sets topics on group DMs, with the user token', async () => {
  const { calls, slackCall } = createTransport()
  const unconfirmed = await setGroupTopic({ channel: 'G0MPIM', topic: 'Hello', userToken: 'xoxp-authorized-human', slackCall })
  assert.equal(unconfirmed.error, 'confirm-required-to-set-group-topic')
  assert.ok(!calls.some(call => call.method === 'conversations.setTopic'))
  const ok = await setGroupTopic({ channel: 'G0MPIM', topic: 'Hello', confirm: true, userToken: 'xoxp-authorized-human', slackCall })
  assert.equal(ok.ok, true)
  assert.equal(calls.find(call => call.method === 'conversations.setTopic').token, 'xoxp-authorized-human')
  const refused = await setGroupTopic({ channel: 'G0PRIVATECHANNEL', topic: 'Hello', confirm: true, userToken: 'xoxp-authorized-human', slackCall })
  assert.deepEqual(refused, { ok: false, error: 'not-a-group-dm', retryable: false, channel: 'G0PRIVATECHANNEL' })
  assert.equal(calls.filter(call => call.method === 'conversations.setTopic').length, 1)
  const dry = await setGroupTopic({ channel: 'G0MPIM', topic: 'Hello', userToken: 'xoxp-authorized-human', dryRun: true, slackCall })
  assert.equal(dry.request.method, 'conversations.setTopic')
  assert.equal(calls.filter(call => call.method === 'conversations.setTopic').length, 1)
  assert.equal((await setGroupTopic({ channel: 'G0MPIM', topic: 'Hello', slackCall })).error, 'user-token-required')
})

test('group creation and topic MCP tools are local-only', async () => {
  const { tools: localTools } = await import('../mcp/tools.local.js')
  const { tools: remoteTools } = await import('../mcp/tools.remote.js')
  for (const name of ['slack_create_group_dm', 'slack_set_group_topic']) {
    assert.ok(localTools[name])
    assert.equal(remoteTools[name], undefined)
  }
  const refused = await localTools.slack_create_group_dm.handler({ peopleNames: PEOPLE }, { env: { SLACK_BOT_TOKEN: 'xoxb-bot' } })
  assert.deepEqual(refused, { ok: false, error: 'user-token-required', retryable: false })
})

test('messageGroupByName refuses a real send without confirm:true and returns the recipients and text to show for approval', async () =>
  withTempDb(async dbPath => {
    const { calls, slackCall } = transport()
    const result = await messageGroupByName({ peopleNames: PEOPLE, text: 'ship it', userToken: 'xoxp-authorized-human', dbPath, slackCall })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'confirm-required-to-message-group-dm')
    assert.equal(result.text, 'ship it')
    assert.equal(result.conversationId, 'G0EXIST')
    assert.deepEqual(result.recipients.map(r => r.id).sort(), [SHRESTHA.id, ALEX.id].sort())
    assert.ok(!calls.some(call => call.method === 'chat.postMessage'))
    const approved = await messageGroupByName({ peopleNames: PEOPLE, text: 'ship it', confirm: true, userToken: 'xoxp-authorized-human', dbPath, slackCall })
    assert.equal(approved.ok, true)
    assert.equal(calls.filter(call => call.method === 'chat.postMessage').length, 1)
  }))

test('the MCP server instructions require approval for group communication and the group tools enforce it', async () => {
  const { MCP_INSTRUCTIONS, tools } = await import('../mcp/tools.local.js')
  assert.match(MCP_INSTRUCTIONS, /GROUP COMMUNICATION REQUIRES APPROVAL EVERY TIME/)
  for (const name of ['slack_create_group_dm', 'slack_message_group_by_name', 'slack_set_group_topic']) {
    assert.match(MCP_INSTRUCTIONS, new RegExp(name))
    assert.ok(tools[name].inputSchema.properties.confirm, `${name} exposes confirm`)
    assert.match(tools[name].description, /confirm:true/)
  }
})
