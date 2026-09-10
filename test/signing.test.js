import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verifySlackSignature } from '../core/signing.js'

function signature(secret, timestamp, body) {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
}

test('verifySlackSignature accepts a valid Slack signature', () => {
  const body = 'command=%2Foutputmode&text=high'
  const timestamp = '1700000000'
  const result = verifySlackSignature({
    signingSecret: 'secret',
    timestamp,
    body,
    signature: signature('secret', timestamp, body),
    nowSeconds: 1700000001,
  })
  assert.equal(result.ok, true)
})

test('verifySlackSignature rejects stale or mismatched signatures', () => {
  assert.equal(
    verifySlackSignature({
      signingSecret: 'secret',
      timestamp: '1700000000',
      body: 'x',
      signature: signature('secret', '1700000000', 'x'),
      nowSeconds: 1700001000,
    }).error,
    'stale-slack-signature'
  )
  assert.equal(
    verifySlackSignature({
      signingSecret: 'secret',
      timestamp: '1700000000',
      body: 'x',
      signature: signature('wrong', '1700000000', 'x'),
      nowSeconds: 1700000001,
    }).error,
    'invalid-slack-signature'
  )
})
