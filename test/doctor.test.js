import { test } from 'node:test'
import assert from 'node:assert/strict'
import { doctor } from '../core/doctor.js'

const emptyConfig = { users: [], watchedChannels: [], owner: {}, remote: { postableChannels: [], readableChannels: [] } }

test('doctor never returns a token value, only presence booleans, even when auth.test succeeds', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    headers: new Map(),
    json: async () => ({ ok: true, team: 'T1', user: 'bot' }),
  })
  try {
    const secret = 'xoxb-super-secret-value'
    const report = await doctor({ env: { SLACK_BOT_TOKEN: secret }, config: emptyConfig, profile: 'local' })
    assert.ok(!JSON.stringify(report).includes(secret))
    assert.equal(report.hasBotToken, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the remote profile never reports token presence or the scope set at all', async () => {
  const report = await doctor({ env: {}, config: emptyConfig, profile: 'remote' })
  assert.equal('hasBotToken' in report, false)
  assert.equal('hasUserToken' in report, false)
  assert.deepEqual(Object.keys(report).sort(), ['connected', 'postableChannels', 'profile', 'readableChannels'])
})
