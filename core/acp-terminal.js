// Serves ACP's terminal/* requests (PLAN D23/D24) — the agent asks the
// client to run a real command; this is genuinely new capability (arbitrary
// command execution triggered from a Slack thread), gated by D24's
// session-start allowlist and D23's repo scoping (a requested cwd outside
// the session's registered repo is rejected, same as fs/*).

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { assertInsideRepo } from './acp-fs.js'

function appendOutput(entry, chunk, byteLimit) {
  entry.output += chunk
  if (byteLimit && Buffer.byteLength(entry.output, 'utf8') > byteLimit) {
    entry.truncated = true
    while (entry.output.length && Buffer.byteLength(entry.output, 'utf8') > byteLimit) {
      entry.output = entry.output.slice(1)
    }
  }
}

export function createTerminalHandlers(repoRoot) {
  const terminals = new Map()

  return {
    async createTerminal({ command, args = [], env = [], cwd, outputByteLimit }) {
      const resolvedCwd = assertInsideRepo(repoRoot, cwd || repoRoot)
      const terminalId = randomUUID()
      const childEnv = { ...process.env }
      for (const { name, value } of env) childEnv[name] = value
      const child = spawn(command, args, { cwd: resolvedCwd, env: childEnv })
      const entry = { child, output: '', truncated: false, exitStatus: null }
      child.stdout.on('data', chunk => appendOutput(entry, chunk.toString('utf8'), outputByteLimit))
      child.stderr.on('data', chunk => appendOutput(entry, chunk.toString('utf8'), outputByteLimit))
      child.on('exit', (code, signal) => {
        entry.exitStatus = { exitCode: code ?? null, signal: signal ?? null }
      })
      terminals.set(terminalId, entry)
      return { terminalId }
    },

    async terminalOutput({ terminalId }) {
      const entry = terminals.get(terminalId)
      if (!entry) throw new Error(`unknown terminal: ${terminalId}`)
      return { output: entry.output, truncated: entry.truncated, exitStatus: entry.exitStatus }
    },

    async waitForTerminalExit({ terminalId }) {
      const entry = terminals.get(terminalId)
      if (!entry) throw new Error(`unknown terminal: ${terminalId}`)
      if (entry.exitStatus) return entry.exitStatus
      return new Promise(resolveExit => {
        entry.child.once('exit', (code, signal) => resolveExit({ exitCode: code ?? null, signal: signal ?? null }))
      })
    },

    async killTerminal({ terminalId }) {
      const entry = terminals.get(terminalId)
      if (!entry) throw new Error(`unknown terminal: ${terminalId}`)
      if (!entry.exitStatus) entry.child.kill('SIGTERM')
      return {}
    },

    async releaseTerminal({ terminalId }) {
      const entry = terminals.get(terminalId)
      if (entry) {
        if (!entry.exitStatus) entry.child.kill('SIGTERM')
        terminals.delete(terminalId)
      }
      return {}
    },
  }
}
