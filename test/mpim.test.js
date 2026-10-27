import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { messageGroupByName } from '../core/mpim.js'
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
    await messageGroupByName({ peopleNames: ['Shrestha Srivastava', 'Alex Doe'], text: 'first', userToken: 'xoxp-authorized-human', dbPath, slackCall: first.slackCall })
    const second = transport()
    const result = await messageGroupByName({ peopleNames: ['Shrestha Srivastava', 'Alex Doe'], text: 'second', userToken: 'xoxp-authorized-human', dbPath, slackCall: second.slackCall })
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
