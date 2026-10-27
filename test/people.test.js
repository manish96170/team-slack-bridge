import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addAccount, setDefaultAccount } from '../core/accounts.js'
import { dmByName } from '../core/people.js'

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-people-'))
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

// Each test gets its own bot token string, never reused across tests --
// core/directory.js caches a successful users.list walk per token
// (D50), and node:test may run these tests concurrently, so sharing one
// token string would let one test's cached directory contents leak
// into another's assertions.
let tokenCounter = 0
function writeAccountEnv(home) {
  const token = `xoxb-anchor-token-${++tokenCounter}`
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.env'), `SLACK_BOT_TOKEN=${token}\n`)
  return token
}

const JANE = { id: 'U0JANE001', name: 'jane.doe', is_bot: false, deleted: false, profile: { display_name: 'Jane Doe', real_name: 'Jane Doe' } }
const JOHN = { id: 'U0JOHN002', name: 'jane.doe', is_bot: false, deleted: false, profile: { display_name: 'John Doe', real_name: 'John Doe' } }

function mockSlackTransport({ members = [JANE] } = {}) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/api/')[1]
    const token = init.headers.Authorization.replace('Bearer ', '')
    calls.push({ method, token })
    let body
    if (method === 'users.list') body = { ok: true, members }
    else if (method === 'conversations.open') body = { ok: true, channel: { id: `D_${token}` } }
    else if (method === 'chat.postMessage') body = { ok: true, channel: `D_${token}`, ts: '1.1' }
    else body = { ok: false, error: 'unexpected_method' }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url,
      headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null), entries: () => [][Symbol.iterator]() },
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }
  return calls
}

function withMockSlack(fn, options) {
  const originalFetch = globalThis.fetch
  const calls = mockSlackTransport(options)
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = originalFetch
  })
}

test('dmByName resolves the account, looks up the person, and sends with an explicit --company', () =>
  withTempHome(dir =>
    withMockSlack(async calls => {
      const anchorHome = join(dir, 'anchor')
      const token = writeAccountEnv(anchorHome)
      addAccount('anchor', anchorHome)

      const result = await dmByName({ accountName: 'anchor', personName: 'jane.doe', text: 'hi' })
      assert.equal(result.ok, true)
      assert.equal(result.account, 'anchor')
      assert.equal(result.person.id, 'U0JANE001')
      assert.equal(result.send.ok, true)
      assert.ok(calls.some(c => c.method === 'users.list' && c.token === token))
      assert.ok(calls.some(c => c.method === 'chat.postMessage' && c.token === token))
    })
  ))

test('dmByName falls back to the registered default account when --company is omitted', () =>
  withTempHome(dir =>
    withMockSlack(async () => {
      const anchorHome = join(dir, 'anchor')
      writeAccountEnv(anchorHome)
      addAccount('anchor', anchorHome)
      setDefaultAccount('anchor')

      const result = await dmByName({ personName: 'jane.doe', text: 'hi' })
      assert.equal(result.ok, true)
      assert.equal(result.account, 'anchor')
    })
  ))

test('dmByName refuses with a specific code when no company is named and no default is configured', () =>
  withTempHome(dir => {
    // Hand-craft a registry with zero accounts -- the one way
    // resolveAccountHome(undefined) actually fails, since addAccount
    // always auto-sets a default the moment any account exists.
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ accounts: {} }))

    return dmByName({ personName: 'jane.doe', text: 'hi' }).then(result => {
      assert.deepEqual(result, { ok: false, error: 'no-company-specified-and-no-default-configured', retryable: false })
    })
  }))

test('dmByName propagates an explicit unregistered --company as account-not-found, not the no-default refusal', () =>
  withTempHome(() =>
    dmByName({ accountName: 'nonexistent', personName: 'jane.doe', text: 'hi' }).then(result => {
      assert.equal(result.ok, false)
      assert.equal(result.error, 'account-not-found')
    })
  ))

test('dmByName propagates ambiguous-user from lookupUser without swallowing it', () =>
  withTempHome(dir =>
    withMockSlack(
      async () => {
        const anchorHome = join(dir, 'anchor')
        writeAccountEnv(anchorHome)
        addAccount('anchor', anchorHome)

        const result = await dmByName({ accountName: 'anchor', personName: 'jane.doe', text: 'hi' })
        assert.equal(result.ok, false)
        assert.equal(result.error, 'ambiguous-user')
        assert.equal(result.matches.length, 2)
      },
      { members: [JANE, JOHN] }
    )
  ))

test('dmByName --dry-run resolves the person but sends nothing and touches no ledger row', () =>
  withTempHome(dir =>
    withMockSlack(async calls => {
      const anchorHome = join(dir, 'anchor')
      writeAccountEnv(anchorHome)
      addAccount('anchor', anchorHome)

      const result = await dmByName({ accountName: 'anchor', personName: 'jane.doe', text: 'hi', dryRun: true })
      assert.equal(result.ok, true)
      assert.equal(result.send.dryRun, true)
      assert.equal(result.person.id, 'U0JANE001')
      assert.ok(!calls.some(c => c.method === 'conversations.open'))
      assert.ok(!calls.some(c => c.method === 'chat.postMessage'))
    })
  ))

test('dmByName requires personName and text', () =>
  withTempHome(async dir => {
    const anchorHome = join(dir, 'anchor')
    writeAccountEnv(anchorHome)
    addAccount('anchor', anchorHome)

    const noName = await dmByName({ accountName: 'anchor', text: 'hi' })
    assert.deepEqual(noName, { ok: false, error: 'person-name-required', retryable: false })

    const noText = await dmByName({ accountName: 'anchor', personName: 'jane.doe' })
    assert.deepEqual(noText, { ok: false, error: 'text-required', retryable: false })
  }))
