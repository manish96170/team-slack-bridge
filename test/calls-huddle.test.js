import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startCall, updateCall, endCall, getCallInfo, resolveJoinUrl } from '../core/calls.js'
import { huddleFromUser, describeHuddleChange, getHuddleStatus, handleHuddleChange, watchedHuddleUserIds, recapPromptText } from '../core/huddle.js'

function fakeSlack(responses = {}) {
  const calls = []
  const slackCall = async (method, token, body = {}) => {
    calls.push({ method, token, body })
    const handler = responses[method]
    return handler ? handler(body) : { ok: true }
  }
  return { calls, slackCall }
}

// ---- calls ----

test('resolveJoinUrl: an explicit https URL wins; otherwise a unique Jitsi room is generated', () => {
  assert.deepEqual(resolveJoinUrl({ joinUrl: 'https://meet.google.com/abc-defg-hij' }), { ok: true, joinUrl: 'https://meet.google.com/abc-defg-hij', provider: 'url' })
  assert.equal(resolveJoinUrl({ joinUrl: 'http://insecure.example.com/x' }).error, 'joinUrl-must-be-https')
  const a = resolveJoinUrl({ title: 'Release sync!' })
  const b = resolveJoinUrl({ title: 'Release sync!' })
  assert.match(a.joinUrl, /^https:\/\/meet\.jit\.si\/release-sync-[0-9a-f]{8}$/)
  assert.notEqual(a.joinUrl, b.joinUrl)
  assert.match(resolveJoinUrl({ title: 'x', jitsiBaseUrl: 'https://jitsi.internal.example/' }).joinUrl, /^https:\/\/jitsi\.internal\.example\/x-/)
  assert.equal(resolveJoinUrl({ title: 'x', jitsiBaseUrl: 'ftp://nope' }).error, 'invalid-jitsiBaseUrl')
})

test('startCall registers the call with calls.add, then posts a call block with the returned id, using only the given token', async () => {
  const { calls, slackCall } = fakeSlack({
    'calls.add': () => ({ ok: true, call: { id: 'R0CALL001' } }),
    'chat.postMessage': body => ({ ok: true, channel: body.channel, ts: '9.9' }),
  })
  const result = await startCall({
    token: 'xoxp-human', channel: 'C1', threadTs: '1.1', title: 'Standup', joinUrl: 'https://meet.google.com/x', userIds: ['U1', 'U2'], slackCall,
  })
  assert.equal(result.ok, true)
  assert.equal(result.callId, 'R0CALL001')
  assert.equal(result.ts, '9.9')
  assert.deepEqual(calls.map(call => call.method), ['calls.add', 'chat.postMessage'])
  assert.ok(calls.every(call => call.token === 'xoxp-human'))
  assert.equal(calls[0].body.join_url, 'https://meet.google.com/x')
  assert.deepEqual(JSON.parse(calls[0].body.users), [{ slack_id: 'U1' }, { slack_id: 'U2' }])
  assert.deepEqual(calls[1].body.blocks, [{ type: 'call', call_id: 'R0CALL001' }])
  assert.equal(calls[1].body.thread_ts, '1.1')
})

test('startCall: post:false registers only; a failed post returns the callId instead of orphaning it', async () => {
  const noPost = fakeSlack({ 'calls.add': () => ({ ok: true, call: { id: 'R0A' } }) })
  const registered = await startCall({ token: 't', title: 'x', post: false, slackCall: noPost.slackCall })
  assert.equal(registered.ok, true)
  assert.equal(registered.callId, 'R0A')
  assert.deepEqual(noPost.calls.map(call => call.method), ['calls.add'])

  const failing = fakeSlack({ 'calls.add': () => ({ ok: true, call: { id: 'R0B' } }), 'chat.postMessage': () => ({ ok: false, error: 'not_in_channel', retryable: false }) })
  const partial = await startCall({ token: 't', channel: 'C1', title: 'x', slackCall: failing.slackCall })
  assert.equal(partial.ok, false)
  assert.equal(partial.error, 'call-registered-but-post-failed: not_in_channel')
  assert.equal(partial.callId, 'R0B')
})

test('startCall dry-run previews both Slack calls without calling Slack; missing channel/token are refused', async () => {
  const { calls, slackCall } = fakeSlack()
  const preview = await startCall({ channel: 'C1', title: 'x', dryRun: true, slackCall })
  assert.equal(preview.ok, true)
  assert.equal(preview.request.add.method, 'calls.add')
  assert.equal(preview.request.post.method, 'chat.postMessage')
  assert.equal(calls.length, 0)
  assert.equal((await startCall({ title: 'x', slackCall })).error, 'channel-required')
  assert.equal((await startCall({ channel: 'C1', slackCall })).error, 'no-token')
})

test('startCall surfaces a calls.add failure untouched and never posts', async () => {
  const { calls, slackCall } = fakeSlack({ 'calls.add': () => ({ ok: false, error: 'missing_scope', retryable: false }) })
  const result = await startCall({ token: 't', channel: 'C1', slackCall })
  assert.deepEqual(result, { ok: false, error: 'missing_scope', retryable: false })
  assert.deepEqual(calls.map(call => call.method), ['calls.add'])
})

test('updateCall / endCall / getCallInfo validate input and map to the right Slack methods', async () => {
  const { calls, slackCall } = fakeSlack()
  assert.equal((await updateCall({ token: 't', slackCall })).error, 'callId-required')
  assert.equal((await updateCall({ token: 't', callId: 'R1', slackCall })).error, 'title-or-joinUrl-required')
  assert.equal((await updateCall({ token: 't', callId: 'R1', joinUrl: 'http://x', slackCall })).error, 'joinUrl-must-be-https')
  await updateCall({ token: 't', callId: 'R1', title: 'New', slackCall })
  await endCall({ token: 't', callId: 'R1', durationSeconds: 61.9, slackCall })
  await getCallInfo({ token: 't', callId: 'R1', slackCall })
  assert.deepEqual(calls.map(call => [call.method, call.body]), [
    ['calls.update', { id: 'R1', title: 'New' }],
    ['calls.end', { id: 'R1', duration: 61 }],
    ['calls.info', { id: 'R1' }],
  ])
  assert.equal((await endCall({ callId: 'R1', dryRun: true, slackCall })).dryRun, true)
})

// ---- huddle ----

const user = (id, state, extra = {}) => ({ id, name: id.toLowerCase(), profile: { display_name: `name-${id}`, huddle_state: state, ...extra } })

test('huddleFromUser normalizes the profile huddle fields', () => {
  assert.deepEqual(huddleFromUser(user('U1', 'in_a_huddle', { huddle_state_channel_id: 'C9', huddle_state_call_id: 'R9', huddle_state_expiration_ts: 1746217265 })), {
    userId: 'U1', displayName: 'name-U1', inHuddle: true, huddleState: 'in_a_huddle', channelId: 'C9', callId: 'R9', expiresAt: '2025-05-02T20:21:05.000Z',
  })
  const idle = huddleFromUser({ id: 'U2', name: 'u2', profile: {} })
  assert.equal(idle.inHuddle, false)
  assert.equal(idle.huddleState, 'default_unset')
})

test('describeHuddleChange detects started / ended / unchanged', () => {
  const inHuddle = huddleFromUser(user('U1', 'in_a_huddle'))
  const free = huddleFromUser(user('U1', 'available_for_huddle'))
  assert.equal(describeHuddleChange(undefined, user('U1', 'in_a_huddle')).transition, 'started')
  assert.equal(describeHuddleChange(free, user('U1', 'in_a_huddle')).transition, 'started')
  assert.equal(describeHuddleChange(inHuddle, user('U1', 'available_for_huddle')).transition, 'ended')
  assert.equal(describeHuddleChange(inHuddle, user('U1', 'in_a_huddle')).transition, 'unchanged')
  assert.equal(describeHuddleChange(undefined, user('U1', 'default_unset')).transition, 'unchanged')
})

test('getHuddleStatus checks the given users and a channel\'s members, de-duplicated, with per-user errors kept', async () => {
  const { calls, slackCall } = fakeSlack({
    'conversations.members': () => ({ ok: true, members: ['U1', 'U2', 'U3'] }),
    'users.info': body => (body.user === 'U3' ? { ok: false, error: 'user_not_found', retryable: false } : { ok: true, user: user(body.user, body.user === 'U2' ? 'in_a_huddle' : 'default_unset') }),
  })
  const result = await getHuddleStatus({ token: 't', userIds: ['U1'], channel: 'C1', slackCall })
  assert.equal(result.ok, true)
  assert.equal(result.checked, 3)
  assert.deepEqual(result.inHuddle.map(entry => entry.userId), ['U2'])
  assert.deepEqual(result.users.find(entry => entry.userId === 'U3'), { userId: 'U3', error: 'user_not_found', retryable: false })
  assert.equal(calls.filter(call => call.method === 'users.info').length, 3)
})

test('getHuddleStatus caps the number of lookups and says so; requires a token and something to check', async () => {
  const ids = Array.from({ length: 10 }, (_, index) => `U${index}`)
  const { calls, slackCall } = fakeSlack({ 'users.info': body => ({ ok: true, user: user(body.user, 'default_unset') }) })
  const result = await getHuddleStatus({ token: 't', userIds: ids, limit: 4, slackCall })
  assert.equal(result.checked, 4)
  assert.equal(result.truncated, true)
  assert.equal(calls.length, 4)
  assert.equal((await getHuddleStatus({ userIds: ['U1'], slackCall })).error, 'no-token')
  assert.equal((await getHuddleStatus({ token: 't', slackCall })).error, 'userIds-or-channel-required')
})

test('handleHuddleChange is off by default and only ever considers watched users', async () => {
  const emitted = []
  const base = { states: new Map(), onClassified: async event => emitted.push(event) }
  const event = { user: user('U_OWNER', 'in_a_huddle') }
  assert.equal((await handleHuddleChange({ ...base, event, config: {} })).reason, 'not-watched')
  assert.equal((await handleHuddleChange({ ...base, event, config: { huddleWatch: { enabled: false }, owner: { slackUserId: 'U_OWNER' } } })).reason, 'not-watched')
  assert.equal((await handleHuddleChange({ ...base, event: { user: user('U_OTHER', 'in_a_huddle') }, config: { huddleWatch: { enabled: true }, owner: { slackUserId: 'U_OWNER' } } })).reason, 'not-watched')
  assert.deepEqual(emitted, [])
  assert.deepEqual(watchedHuddleUserIds({ huddleWatch: { enabled: true, userIds: ['UA'] }, owner: { slackUserId: 'U_OWNER' } }), ['UA'])
  assert.deepEqual(watchedHuddleUserIds({ huddleWatch: { enabled: true }, owner: { slackUserId: 'U_OWNER' } }), ['U_OWNER'])
})

test('handleHuddleChange emits started then ended, remembers the channel, and DMs a recap prompt only when asked to', async () => {
  const emitted = []
  const dms = []
  const states = new Map()
  const config = { huddleWatch: { enabled: true, promptRecap: true }, owner: { slackUserId: 'U_OWNER' } }
  const args = { states, config, onClassified: async event => emitted.push(event), sendDm: async dm => dms.push(dm) }

  const started = await handleHuddleChange({ ...args, event: { user: user('U_OWNER', 'in_a_huddle', { huddle_state_channel_id: 'C9' }) } })
  assert.equal(started.transition, 'started')
  assert.equal(dms.length, 0)

  assert.equal((await handleHuddleChange({ ...args, event: { user: user('U_OWNER', 'in_a_huddle', { huddle_state_channel_id: 'C9' }) } })).handled, false)

  const ended = await handleHuddleChange({ ...args, event: { user: user('U_OWNER', 'available_for_huddle') } })
  assert.equal(ended.transition, 'ended')
  assert.deepEqual(emitted.map(event => event.kind), ['huddle-started', 'huddle-ended'])
  assert.equal(emitted[1].huddle.channelId, 'C9')
  assert.equal(dms.length, 1)
  assert.equal(dms[0].userId, 'U_OWNER')
  assert.match(dms[0].text, /<#C9>/)
  assert.match(dms[0].text, /doesn't give me its audio/)

  const quiet = { ...args, config: { huddleWatch: { enabled: true }, owner: { slackUserId: 'U_OWNER' } }, states: new Map(), sendDm: async dm => dms.push(dm) }
  await handleHuddleChange({ ...quiet, event: { user: user('U_OWNER', 'in_a_huddle') } })
  await handleHuddleChange({ ...quiet, event: { user: user('U_OWNER', 'default_unset') } })
  assert.equal(dms.length, 1, 'no recap DM without promptRecap')
  assert.match(recapPromptText(undefined), /^Your huddle just ended/)
})
