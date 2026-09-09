import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, START_NOW_TRIGGERS } from '../core/classify.js'

const config = {
  owner: { slackUserId: 'U_OWNER' },
  dmAllowlist: ['U_ALLOWED'],
  watchedChannels: [
    { channel: 'C_REVIEW', purpose: 'review-request' },
    { channel: 'C_TEAM', purpose: 'team-request' },
  ],
}

test('a self-DM from the owner without a trigger word is self-dm', () => {
  const result = classify({ type: 'message', channel_type: 'im', user: 'U_OWNER', text: 'reminder to self' }, config)
  assert.equal(result.kind, 'self-dm')
})

test('a self-DM from the owner with each whole-word trigger is self-dm-start-now', () => {
  for (const trigger of START_NOW_TRIGGERS) {
    const result = classify({ type: 'message', channel_type: 'im', user: 'U_OWNER', text: `please ${trigger}` }, config)
    assert.equal(result.kind, 'self-dm-start-now', `trigger "${trigger}" should fire`)
  }
})

test('a trigger word must be uppercase/lowercase-insensitive', () => {
  const result = classify({ type: 'message', channel_type: 'im', user: 'U_OWNER', text: 'SRN please' }, config)
  assert.equal(result.kind, 'self-dm-start-now')
})

test('the required negative case: "sra" inside "extras" must not fire', () => {
  const result = classify({ type: 'message', channel_type: 'im', user: 'U_OWNER', text: 'grab the extras please' }, config)
  assert.equal(result.kind, 'self-dm')
})

test('a DM from anyone not the owner and not on the allow-list is ignored, never a proposal', () => {
  const result = classify({ type: 'message', channel_type: 'im', user: 'U_SOMEONE_ELSE', text: 'srn' }, config)
  assert.equal(result.kind, 'ignore')
  assert.equal(result.reason, 'dm-not-owner-or-allowed')
})

test('a DM from an allow-listed non-owner is a dm-request, never self-dm-shaped, regardless of trigger words', () => {
  const result = classify({ type: 'message', channel_type: 'im', user: 'U_ALLOWED', text: 'srn' }, config)
  assert.equal(result.kind, 'dm-request')
})

test('a DM is ignored when no owner is configured at all', () => {
  const result = classify({ type: 'message', channel_type: 'im', user: 'U_OWNER', text: 'srn' }, {})
  assert.equal(result.kind, 'ignore')
})

test('a mention in a watched review-request channel classifies as review-request', () => {
  const result = classify({ type: 'app_mention', channel: 'C_REVIEW', user: 'U_X', text: '@bot please look' }, config)
  assert.equal(result.kind, 'review-request')
})

test('a mention in a watched team-request channel classifies as team-request', () => {
  const result = classify({ type: 'app_mention', channel: 'C_TEAM', user: 'U_X', text: '@bot reassign this' }, config)
  assert.equal(result.kind, 'team-request')
})

test('a mention in an unwatched channel is ignored', () => {
  const result = classify({ type: 'app_mention', channel: 'C_RANDOM', user: 'U_X', text: '@bot hi' }, config)
  assert.equal(result.kind, 'ignore')
  assert.equal(result.reason, 'unwatched-channel')
})

test('an unrecognized event type is ignored, not thrown', () => {
  const result = classify({ type: 'reaction_added' }, config)
  assert.equal(result.kind, 'ignore')
})

test('a null/undefined event is ignored, not thrown', () => {
  assert.equal(classify(undefined, config).kind, 'ignore')
  assert.equal(classify(null, config).kind, 'ignore')
})
