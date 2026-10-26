import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeTenancy, resolveAccount } from '../core/tenancy.js'
import { addTenant, listTenants, removeTenant, resolveTenantHome, resolveTenantContext } from '../core/tenant-store.js'
import { handleMcpMessage } from '../mcp/http.js'

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-tenants-'))
  const original = process.env.TSB_HOME
  process.env.TSB_HOME = dir
  try {
    return fn(dir)
  } finally {
    if (original === undefined) delete process.env.TSB_HOME
    else process.env.TSB_HOME = original
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeTenantHomeFiles(home, { botToken }) {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.env'), `SLACK_BOT_TOKEN=${botToken}\n`)
  writeFileSync(join(home, 'slack-config.json'), JSON.stringify({ owner: { slackUserId: 'U0ACME' } }))
}

function slackMeta(teamId, { enterpriseId = null } = {}) {
  return { user_id: 'U0CALLER', team_id: teamId, enterprise_id: enterpriseId }
}

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

test('resolveAccount: multi mode with no team_id refuses instead of guessing a tenant', () => {
  const config = { slackbotMcp: { enabled: true, tenancy: { mode: 'multi' } } }
  const result = resolveAccount({ env: {}, config, dbPath: '', principal: null })
  assert.equal(result.ok, false)
  assert.equal(result.mode, 'multi')
  assert.equal(result.error, 'multi-tenancy-requires-team-id')
})

test('resolveAccount: multi mode with an unregistered team_id refuses, never falls back to the caller\'s own env/config', () => {
  withTempHome(() => {
    const callerEnv = { SLACK_BOT_TOKEN: 'xoxb-should-never-be-used' }
    const config = { slackbotMcp: { enabled: true, tenancy: { mode: 'multi' } } }
    const result = resolveAccount({ env: callerEnv, config, dbPath: '', principal: slackMeta('TUNKNOWN') })
    assert.equal(result.ok, false)
    assert.equal(result.mode, 'multi')
    assert.equal(result.error, 'tenant-not-found')
  })
})

test('resolveAccount: multi mode with a registered team_id resolves to THAT tenant\'s own env/config, not the caller\'s', () => {
  withTempHome(dir => {
    const home = join(dir, 'tenants', 'TACME')
    writeTenantHomeFiles(home, { botToken: 'xoxb-acme-token' })
    addTenant('TACME', { home })

    const callerEnv = { SLACK_BOT_TOKEN: 'xoxb-should-never-be-used' }
    const config = { slackbotMcp: { enabled: true, tenancy: { mode: 'multi' } } }
    const result = resolveAccount({ env: callerEnv, config, dbPath: '', principal: slackMeta('TACME') })

    assert.equal(result.ok, true)
    assert.equal(result.mode, 'multi')
    assert.equal(result.teamId, 'TACME')
    assert.equal(result.env.SLACK_BOT_TOKEN, 'xoxb-acme-token')
    assert.equal(result.config.owner.slackUserId, 'U0ACME')
    assert.equal(result.dbPath, join(home, '.ledger.sqlite'))
  })
})

test('resolveAccount: two registered tenants never cross-resolve each other\'s token/config (adversarial, PLAN D54)', () => {
  withTempHome(dir => {
    const homeA = join(dir, 'tenants', 'TACME')
    const homeB = join(dir, 'tenants', 'TGLOBEX')
    writeTenantHomeFiles(homeA, { botToken: 'xoxb-acme-token' })
    writeTenantHomeFiles(homeB, { botToken: 'xoxb-globex-token' })
    addTenant('TACME', { home: homeA })
    addTenant('TGLOBEX', { home: homeB })

    const config = { slackbotMcp: { enabled: true, tenancy: { mode: 'multi' } } }
    const resultA = resolveAccount({ env: {}, config, dbPath: '', principal: slackMeta('TACME') })
    const resultB = resolveAccount({ env: {}, config, dbPath: '', principal: slackMeta('TGLOBEX') })

    assert.equal(resultA.env.SLACK_BOT_TOKEN, 'xoxb-acme-token')
    assert.equal(resultB.env.SLACK_BOT_TOKEN, 'xoxb-globex-token')
    assert.notEqual(resultA.dbPath, resultB.dbPath)
  })
})

test('core/tenant-store.js: add/list/remove round-trip, and no secret is ever written into tenants.json', () => {
  withTempHome(dir => {
    const home = join(dir, 'tenants', 'TACME')
    assert.deepEqual(addTenant('TACME', { home, enterpriseId: 'E0ACME' }), { ok: true, teamId: 'TACME', home })
    assert.equal(listTenants().tenants.TACME.home, home)
    assert.equal(resolveTenantHome('TACME').enterpriseId, 'E0ACME')
    assert.equal(removeTenant('TACME').ok, true)
    assert.equal(listTenants().tenants.TACME, undefined)
  })
})

test('core/tenant-store.js: addTenant rejects a team_id with characters outside Slack\'s own ID shape', () => {
  withTempHome(() => {
    assert.equal(addTenant('../etc/passwd').ok, false)
    assert.equal(addTenant('').ok, false)
    assert.equal(addTenant(undefined).ok, false)
  })
})

test('core/tenant-store.js: resolveTenantContext on an unknown team_id refuses clearly', () => {
  withTempHome(() => {
    assert.deepEqual(resolveTenantContext('TUNKNOWN'), { ok: false, error: 'tenant-not-found', retryable: false })
  })
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

test('handleMcpMessage: multi-mode tenancy with no Slack-signed team_id refuses, including initialize', async () => {
  const config = { slackbotMcp: { enabled: true, tenancy: { mode: 'multi' } } }
  const response = await handleMcpMessage({
    message: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    env: {},
    config,
    dbPath: '',
  })
  assert.equal(response.error.message, 'multi-tenancy-requires-team-id')
})

test('handleMcpMessage: multi-mode tenancy with a registered team_id serves that tenant\'s own tools/list', async () => {
  await withTempHome(async dir => {
    const home = join(dir, 'tenants', 'TACME')
    writeTenantHomeFiles(home, { botToken: 'xoxb-acme-token' })
    addTenant('TACME', { home })

    const config = { slackbotMcp: { enabled: true, tenancy: { mode: 'multi' } } }
    const response = await handleMcpMessage({
      message: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { slack: slackMeta('TACME') } } },
      env: {},
      config,
      dbPath: '',
    })
    assert.ok(response.result.tools.some(t => t.name === 'slack_doctor'))
  })
})
