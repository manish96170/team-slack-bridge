import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalMcpServer } from '../listen/mcp-http.js'
import { addAccount } from '../core/accounts.js'

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
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: JSON.stringify(message) })
  return res.json()
}

test('single-account daemon exposes the full local tool set, unlike the 9-tool remote profile', () =>
  withTempHome(async () => {
    await withServer({ accountMode: 'single', port: 0 }, async port => {
      const response = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
      const names = response.result.tools.map(tool => tool.name)
      assert.ok(names.includes('slack_dm'), 'slack_dm should be present on the local daemon')
      assert.ok(names.includes('slack_ask'), 'slack_ask should be present on the local daemon')
      assert.ok(names.length > 9, 'local daemon tool set should exceed the remote 9-tool set')
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
