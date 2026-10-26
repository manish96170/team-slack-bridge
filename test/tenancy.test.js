import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTenancy, resolveAccount } from '../core/tenancy.js'
import { handleMcpMessage } from '../mcp/http.js'

test('normalizeTenancy defaults to single, rejects unknown modes', () => {
  assert.equal(normalizeTenancy().mode, 'single')
  assert.equal(normalizeTenancy({}).mode, 'single')
  assert.equal(normalizeTenancy({ mode: 'single' }).mode, 'single')
  assert.equal(normalizeTenancy({ mode: 'multi' }).mode, 'multi')
  assert.equal(normalizeTenancy({ mode: 'nonsense' }).mode, 'single')
})

test('resolveAccount: single mode (default) returns the caller\'s own env/config/dbPath unchanged', () => {
  const env = { SLACK_BOT_TOKEN: 'xoxb-x' }
  const config = { slackbotMcp: { enabled: true } }
  const dbPath = '/tmp/whatever.sqlite'

  const result = resolveAccount({ env, config, dbPath })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'single')
  // Same references back out, not just equal values -- this is the "byte
  // identical to before this refactor" guarantee the roadmap requires.
  assert.equal(result.env, env)
  assert.equal(result.config, config)
  assert.equal(result.dbPath, dbPath)
})

test('resolveAccount: absent tenancy config behaves exactly like an explicit single', () => {
  const config = { slackbotMcp: { enabled: true } } // no .tenancy key at all
  const result = resolveAccount({ env: {}, config, dbPath: '' })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'single')
})

test('resolveAccount: multi mode refuses clearly instead of silently acting like single', () => {
  const config = { slackbotMcp: { enabled: true, tenancy: { mode: 'multi' } } }
  const result = resolveAccount({ env: { SLACK_BOT_TOKEN: 'xoxb-x' }, config, dbPath: '/tmp/x.sqlite' })
  assert.equal(result.ok, false)
  assert.equal(result.mode, 'multi')
  assert.equal(result.error, 'multi-tenancy-not-yet-implemented')
  assert.equal(result.retryable, false)
})

test('handleMcpMessage: single-mode tenancy (default) does not change the existing initialize response', async () => {
  const response = await handleMcpMessage({
    message: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    env: {},
    config: {},
    dbPath: '',
  })
  assert.equal(response.result.protocolVersion, '2024-11-05')
})

test('handleMcpMessage: multi-mode tenancy refuses every method, including initialize', async () => {
  const config = { slackbotMcp: { enabled: true, tenancy: { mode: 'multi' } } }
  const response = await handleMcpMessage({
    message: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    env: {},
    config,
    dbPath: '',
  })
  assert.equal(response.error.message, 'multi-tenancy-not-yet-implemented')
})
