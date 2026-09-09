import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveMentions } from '../core/identity.js'
import { postToChannel } from '../core/post.js'
import { dm } from '../core/dm.js'

const config = {
  users: [
    { name: 'PJ', slackHandle: '@pj', slackUserId: 'U_PJ' },
    { name: 'PK', slackHandle: '@pk', slackUserId: 'U_PK' },
  ],
  watchedChannels: [],
  owner: {},
  dmAllowlist: [],
  remote: { postableChannels: [], readableChannels: [] },
}

test('resolveMentions turns a configured @handle into a real <@USERID> mention', () => {
  assert.equal(resolveMentions('Reviewer: @PJ @PK', config), 'Reviewer: <@U_PJ> <@U_PK>')
})

test('resolveMentions leaves an unconfigured @handle exactly as typed', () => {
  assert.equal(resolveMentions('cc @someone-unknown', config), 'cc @someone-unknown')
})

test('resolveMentions is a no-op with no config or no text', () => {
  assert.equal(resolveMentions('@PJ', undefined), '@PJ')
  assert.equal(resolveMentions(undefined, config), undefined)
})

test('postToChannel resolves mentions in text before building the request, in dry-run too', async () => {
  const result = await postToChannel({ channel: '#x', text: 'ping @PJ', config, dryRun: true })
  assert.equal(result.request.body.text, 'ping <@U_PJ>')
})

test('dm resolves mentions in text before building the request', async () => {
  const result = await dm({ userId: 'U_OTHER', text: 'ping @PK', config, dryRun: true })
  assert.equal(result.request.body.text, 'ping <@U_PK>')
})
