import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postToChannel, react, updateMessage, deleteMessage } from '../core/post.js'
import { dm } from '../core/dm.js'

test('postToChannel dry-run resolves and formats the request but sends nothing, even with no token', async () => {
  const result = await postToChannel({ channel: '#x', text: 'hi', dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.request.method, 'chat.postMessage')
  assert.equal(result.request.body.channel, '#x')
})

test('react dry-run requires no token', async () => {
  const result = await react({ channel: '#x', ts: '1.1', emoji: 'eyes', dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
})

test('updateMessage dry-run requires no token and skips the ledger-ownership check', async () => {
  const result = await updateMessage({ channel: '#x', ts: '1.1', text: 'new', requireLedgerOwnership: true, dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
})

test('deleteMessage dry-run requires no token', async () => {
  const result = await deleteMessage({ channel: '#x', ts: '1.1', dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
})

test('dm dry-run requires no token at all, not even a bot token to open the DM', async () => {
  const result = await dm({ userId: 'U123', text: 'hi', dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
})

test('without dry-run, a missing token is a structured, non-retryable failure — never a throw', async () => {
  const result = await postToChannel({ channel: '#x', text: 'hi' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-token')
  assert.equal(result.retryable, false)
})
