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

test('doctor checks app token and configured channel membership without leaking tokens', async () => {
  const calls = []
  const slackCall = async (method, token, body) => {
    calls.push({ method, token, body })
    if (method === 'auth.test') return { ok: true, team: 'T1', user: 'bot' }
    if (method === 'apps.connections.open') return { ok: true, url: 'wss://example.invalid/socket' }
    if (method === 'conversations.info') return { ok: true, channel: { id: body.channel, name: 'deploys', is_member: true, is_archived: false } }
    return { ok: false, error: 'unexpected' }
  }
  const report = await doctor({
    env: { SLACK_BOT_TOKEN: 'xoxb-secret', SLACK_APP_TOKEN: 'xapp-secret' },
    config: { ...emptyConfig, owner: { slackUserId: 'U1' }, watchedChannels: [{ channel: 'C1', purpose: 'review-request' }] },
    slackCall,
  })
  assert.equal(report.listener.configured, true)
  assert.equal(report.hasSigningSecret, false)
  assert.equal(report.outputMode, 'medium')
  assert.equal(report.slackbotMcp.enabled, false)
  assert.equal(report.slackbotMcp.manifestScopeRequired, 'mcp:connect')
  assert.deepEqual(report.socketMode, { ok: true })
  assert.equal(report.channels[0].isMember, true)
  assert.ok(!JSON.stringify(report).includes('xoxb-secret'))
  assert.ok(!JSON.stringify(report).includes('xapp-secret'))
  assert.deepEqual(calls.map(call => call.method), ['auth.test', 'apps.connections.open', 'conversations.info'])
})

test('doctor reports Slackbot MCP readiness without network calls', async () => {
  const report = await doctor({
    env: {},
    config: {
      ...emptyConfig,
      slackbotMcp: {
        enabled: true,
        serverKey: 'team-slack-bridge',
        url: 'http://localhost:8917/mcp',
        authType: 'slack_identity_auth',
      },
    },
  })
  assert.equal(report.slackbotMcp.enabled, true)
  assert.equal(report.slackbotMcp.ready, false)
  assert.equal(report.slackbotMcp.error, 'slackbot-mcp-requires-https-url')
})
