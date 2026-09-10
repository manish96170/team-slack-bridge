import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publishHome } from '../core/home.js'

test('publishHome dry-run requires no token and builds a views.publish request', async () => {
  const result = await publishHome({ userId: 'U1', dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.request.method, 'views.publish')
  assert.equal(result.request.body.user_id, 'U1')
  assert.equal(result.request.body.view.type, 'home')
  assert.ok(result.request.body.view.blocks.length > 0)
})

test('publishHome without a userId is refused before touching Slack', async () => {
  const result = await publishHome({ dryRun: true })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'userId-required')
})

test('publishHome without a token (non-dry-run) fails structured, not thrown', async () => {
  const result = await publishHome({ userId: 'U1' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-token')
})
