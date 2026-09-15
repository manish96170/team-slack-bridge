import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTerminalHandlers } from '../core/acp-terminal.js'

async function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-acp-terminal-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('createTerminal runs a real command and terminalOutput captures its output and exit status', async () => {
  await withTempRepo(async repoRoot => {
    const handlers = createTerminalHandlers(repoRoot)
    const { terminalId } = await handlers.createTerminal({ command: process.execPath, args: ['-e', 'console.log("hi from acp terminal")'] })
    const status = await handlers.waitForTerminalExit({ terminalId })
    assert.equal(status.exitCode, 0)
    const output = await handlers.terminalOutput({ terminalId })
    assert.ok(output.output.includes('hi from acp terminal'))
    assert.equal(output.truncated, false)
  })
})

test('createTerminal rejects a cwd outside the registered repo (PLAN D23)', async () => {
  await withTempRepo(async repoRoot => {
    const handlers = createTerminalHandlers(repoRoot)
    await assert.rejects(() => handlers.createTerminal({ command: 'true', cwd: '/tmp' }))
  })
})

test('killTerminal stops a long-running command', async () => {
  await withTempRepo(async repoRoot => {
    const handlers = createTerminalHandlers(repoRoot)
    const { terminalId } = await handlers.createTerminal({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'] })
    await handlers.killTerminal({ terminalId })
    const status = await handlers.waitForTerminalExit({ terminalId })
    assert.notEqual(status.signal, null)
  })
})

test('terminalOutput on an unknown terminalId fails clearly instead of hanging', async () => {
  await withTempRepo(async repoRoot => {
    const handlers = createTerminalHandlers(repoRoot)
    await assert.rejects(() => handlers.terminalOutput({ terminalId: 'no-such-terminal' }))
  })
})

test('releaseTerminal kills a still-running command and frees the terminal id', async () => {
  await withTempRepo(async repoRoot => {
    const handlers = createTerminalHandlers(repoRoot)
    const { terminalId } = await handlers.createTerminal({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'] })
    await handlers.releaseTerminal({ terminalId })
    await assert.rejects(() => handlers.terminalOutput({ terminalId }))
  })
})

test('outputByteLimit truncates from the beginning of the output', async () => {
  await withTempRepo(async repoRoot => {
    const handlers = createTerminalHandlers(repoRoot)
    const { terminalId } = await handlers.createTerminal({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("a".repeat(200))'],
      outputByteLimit: 50,
    })
    await handlers.waitForTerminalExit({ terminalId })
    const output = await handlers.terminalOutput({ terminalId })
    assert.equal(output.truncated, true)
    assert.ok(Buffer.byteLength(output.output, 'utf8') <= 50)
  })
})
