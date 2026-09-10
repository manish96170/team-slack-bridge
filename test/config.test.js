import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../core/identity.js'

test('loadConfig supplies dormant integration defaults', () => {
  const config = loadConfig('/no/such/config.json')
  assert.equal(config.outputMode, 'medium')
  assert.equal(config.http.enabled, false)
  assert.equal(config.slashCommands.outputModeCommand, '/outputmode')
  assert.equal(config.agentSessions.enabled, false)
  assert.equal(config.openacp.adapterPackage, '@openacp/slack-adapter')
  assert.deepEqual(config.slackbotMcp, {
    enabled: false,
    serverKey: 'team-slack-bridge',
    url: '',
    authType: 'slack_identity_auth',
    authProviderKey: '',
    exposeWriteTools: false,
    allowedTools: [],
    rateLimitPerMinute: 30,
  })
})

test('loadConfig validates outputMode and preserves enabled integration config', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'config-test-')), 'slack-config.json')
  writeFileSync(path, JSON.stringify({
    outputMode: 'invalid',
    http: { enabled: true, port: 9999 },
    slashCommands: { enabled: true },
    slackbotMcp: {
      enabled: true,
      serverKey: 'internal-tools',
      url: 'https://bridge.example.com/mcp',
      authType: 'no_auth',
      exposeWriteTools: true,
      allowedTools: ['slack_doctor'],
      rateLimitPerMinute: 10,
    },
  }))
  const config = loadConfig(path)
  assert.equal(config.outputMode, 'medium')
  assert.equal(config.http.enabled, true)
  assert.equal(config.http.port, 9999)
  assert.equal(config.slashCommands.enabled, true)
  assert.deepEqual(config.slackbotMcp, {
    enabled: true,
    serverKey: 'internal-tools',
    url: 'https://bridge.example.com/mcp',
    authType: 'no_auth',
    authProviderKey: '',
    exposeWriteTools: true,
    allowedTools: ['slack_doctor'],
    rateLimitPerMinute: 10,
  })
})
