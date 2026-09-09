import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduleMessage, deleteScheduledMessage } from '../core/schedule.js'

test('schedule dry-run accepts an ISO timestamp and converts it to Unix seconds', async () => {
  const postAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const result = await scheduleMessage({ channel: '#x', text: 'hi', postAt, dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.request.method, 'chat.scheduleMessage')
  assert.equal(typeof result.request.body.post_at, 'number')
})

test('schedule dry-run accepts raw Unix seconds', async () => {
  const postAt = Math.floor(Date.now() / 1000) + 3600
  const result = await scheduleMessage({ channel: '#x', text: 'hi', postAt, dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.request.body.post_at, postAt)
})

test('a postAt less than 10 seconds out is refused, not sent', async () => {
  const postAt = Math.floor(Date.now() / 1000) + 1
  const result = await scheduleMessage({ channel: '#x', text: 'hi', postAt, dryRun: true })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'postAt-must-be-at-least-10-seconds-in-the-future')
})

test('a postAt more than 120 days out is refused', async () => {
  const postAt = Math.floor(Date.now() / 1000) + 121 * 24 * 60 * 60
  const result = await scheduleMessage({ channel: '#x', text: 'hi', postAt, dryRun: true })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'postAt-too-far-in-the-future-max-120-days')
})

test('an unparseable postAt is refused, not thrown', async () => {
  const result = await scheduleMessage({ channel: '#x', text: 'hi', postAt: 'not-a-date', dryRun: true })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'invalid-postAt')
})

test('missing postAt is refused', async () => {
  const result = await scheduleMessage({ channel: '#x', text: 'hi', dryRun: true })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'postAt-required')
})

test('deleteScheduledMessage dry-run requires no token', async () => {
  const result = await deleteScheduledMessage({ channel: '#x', scheduledMessageId: 'Q123', dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
})
