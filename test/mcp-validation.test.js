import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateArguments } from '../mcp/validation.js'
import { schemas } from '../mcp/schema.js'

test('MCP validation rejects unknown arguments even when the handler would ignore them', () => {
  assert.equal(validateArguments(schemas.slack_post, { channel: '#x', text: 'hi', username: 'spoof' }), 'unknown argument: username')
})

test('MCP validation rejects missing required arguments', () => {
  assert.equal(validateArguments(schemas.slack_reply, { channel: '#x', text: 'hi' }), 'missing required argument: threadTs')
})

test('MCP validation rejects invalid enum values', () => {
  assert.equal(
    validateArguments(schemas.slack_ask, { userId: 'U1', question: 'continue?', kind: 'maybe' }),
    'kind must be one of: question, approval'
  )
})

test('MCP validation accepts valid multi-type values', () => {
  assert.equal(validateArguments(schemas.slack_schedule_message, { channel: '#x', text: 'hi', postAt: 1790000000 }), null)
})

test('MCP validation rejects arrays for object properties', () => {
  assert.equal(validateArguments(schemas.slack_agent_session_create, { metadata: [] }), 'metadata must be object')
})
