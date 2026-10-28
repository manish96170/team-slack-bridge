import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalMcpServer } from '../listen/mcp-http.js'
import { addAccount } from '../core/accounts.js'
import { getSlackClient } from '../core/slack.js'

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-daemon-'))
  const original = process.env.TSB_HOME
  process.env.TSB_HOME = dir
  return (async () => {
    try {
      return await fn(dir)
    } finally {
      if (original === undefined) delete process.env.TSB_HOME
      else process.env.TSB_HOME = original
      rmSync(dir, { recursive: true, force: true })
    }
  })()
}

async function withServer(opts, fn) {
  const { server, listen, close } = createLocalMcpServer(opts)
  await listen()
  const port = server.address().port
  try {
    return await fn(port)
  } finally {
    await close()
  }
}

async function rpc(port, message) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) })
  return res.json()
}

test('single-account daemon exposes the full local tool set, unlike the restricted remote profile', () =>
  withTempHome(async () => {
    await withServer({ accountMode: 'single', port: 0 }, async port => {
      const response = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
      const names = response.result.tools.map(tool => tool.name)
      assert.ok(names.includes('slack_dm'), 'slack_dm should be present on the local daemon')
      assert.ok(names.includes('slack_ask'), 'slack_ask should be present on the local daemon')
      assert.ok(names.length > 11, 'local daemon tool set should exceed the restricted remote tool set')
    })
  }))

test('local daemon rejects browser-origin and non-JSON POSTs before any MCP tool can run', () =>
  withTempHome(async () => {
    await withServer({ accountMode: 'single', port: 0 }, async port => {
      const browser = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { origin: 'https://evil.example.com', 'content-type': 'text/plain' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      assert.equal(browser.status, 403)
      assert.equal((await browser.json()).error, 'browser-origin-not-allowed')

      const nonJson = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      })
      assert.equal(nonJson.status, 415)
      assert.equal((await nonJson.json()).error, 'application-json-required')
    })
  }))

// D67 — found live: a calling agent set viaBot:true/anonymousMessage:true on
// a plain DM unprompted. Per-tool/per-field descriptions are only read once
// a model is already considering that tool; `initialize`'s `instructions`
// field is read once, before any tool call — the strongest lever available,
// even though it's still advisory, not an enforcement mechanism.
test('initialize response carries instructions warning against unprompted viaBot/anonymousMessage', () =>
  withTempHome(async () => {
    await withServer({ accountMode: 'single', port: 0 }, async port => {
      const response = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      assert.match(response.result.instructions, /viaBot/)
      assert.match(response.result.instructions, /never set either on your own initiative/)
    })
  }))

test('single-account daemon rejects an account argument naming a different account', () =>
  withTempHome(async dir => {
    addAccount('work', join(dir, 'work'))
    await withServer({ accountMode: 'single', port: 0 }, async port => {
      const response = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slack_doctor', arguments: { account: 'work' } } })
      assert.ok(response.error.message.includes('single-account mode'))
    })
  }))

test('multi-account daemon resolves slack_doctor per account, reading each account\'s own config (no network calls: no bot token set)', () =>
  withTempHome(async dir => {
    const workHome = join(dir, 'work')
    mkdirSync(workHome, { recursive: true })
    writeFileSync(join(workHome, 'slack-config.json'), JSON.stringify({ users: [{ name: 'work-person', slackUserId: 'U_WORK' }] }))
    writeFileSync(join(dir, 'slack-config.json'), JSON.stringify({ users: [] }))
    addAccount('work', workHome)

    await withServer({ accountMode: 'multi', port: 0 }, async port => {
      const defaultResult = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slack_doctor', arguments: {} } })
      const workResult = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slack_doctor', arguments: { account: 'work' } } })
      const defaultReport = JSON.parse(defaultResult.result.content[0].text)
      const workReport = JSON.parse(workResult.result.content[0].text)
      assert.equal(defaultReport.configuredUsers, 0)
      assert.equal(workReport.configuredUsers, 1)
    })
  }))

test('multi-account daemon errors clearly on an unknown account name instead of silently falling back', () =>
  withTempHome(async () => {
    await withServer({ accountMode: 'multi', port: 0 }, async port => {
      const response = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slack_doctor', arguments: { account: 'nonexistent' } } })
      const report = JSON.parse(response.result.content[0].text)
      assert.equal(report.ok, false)
      assert.equal(report.error, 'account-not-found')
      assert.equal(response.result.isError, true)
    })
  }))

test('multi-account file deletion uses only the selected account and requires confirmation', () =>
  withTempHome(async dir => {
    const workHome = join(dir, 'work')
    mkdirSync(workHome, { recursive: true })
    writeFileSync(join(dir, '.env'), 'SLACK_USER_TOKEN=xoxp-delete-default\n')
    writeFileSync(join(workHome, '.env'), 'SLACK_USER_TOKEN=xoxp-delete-work\n')
    writeFileSync(join(workHome, 'slack-config.json'), JSON.stringify({ fileDeletion: { enabled: true } }))
    addAccount('work', workHome)
    const workClient = getSlackClient('xoxp-delete-work', { noRetry: true })
    const defaultClient = getSlackClient('xoxp-delete-default', { noRetry: true })
    const originalWork = workClient.apiCall
    const originalDefault = defaultClient.apiCall
    const calls = []
    workClient.apiCall = async (method, body) => { calls.push({ account: 'work', method, body }); return { ok: true } }
    defaultClient.apiCall = async (method, body) => { calls.push({ account: 'default', method, body }); return { ok: true } }
    try {
      await withServer({ accountMode: 'multi', port: 0 }, async port => {
        const args = { account: 'work', fileId: 'F123' }
        const refusal = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slack_delete_file', arguments: args } })
        assert.equal(JSON.parse(refusal.result.content[0].text).error, 'file-deletion-confirmation-required')
        assert.equal(calls.length, 0)
        const result = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slack_delete_file', arguments: { ...args, confirm: true } } })
        assert.equal(JSON.parse(result.result.content[0].text).ok, true)
        assert.deepEqual(calls, [{ account: 'work', method: 'files.delete', body: { file: 'F123' } }])
      })
    } finally {
      workClient.apiCall = originalWork
      defaultClient.apiCall = originalDefault
    }
  }))
