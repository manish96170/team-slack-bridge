// PID/log-file process supervisor for the local MCP HTTP daemon
// (listen/mcp-http.js), mirroring listen/daemon.js's pattern for the Socket
// Mode listener. Kept as a separate implementation rather than a shared
// module so the two daemons can never mistake each other's PID file for
// their own.

import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

export const MCP_DAEMON_PID_PATH = join(repoRoot, '.mcp-daemon.pid')
export const MCP_DAEMON_LOG_PATH = join(repoRoot, '.mcp-daemon.log')
const MCP_DAEMON_SCRIPT = join(repoRoot, 'cli/mcp-daemon-run.js')

function readPidRecord() {
  if (!existsSync(MCP_DAEMON_PID_PATH)) return null
  try {
    const parsed = JSON.parse(readFileSync(MCP_DAEMON_PID_PATH, 'utf8').trim())
    return Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed : null
  } catch {
    return null
  }
}

export function readPid() {
  return readPidRecord()?.pid || null
}

export function isRunning(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function isMcpDaemonProcess(pid) {
  if (!isRunning(pid)) return false
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
    return command.includes(MCP_DAEMON_SCRIPT) || command.includes('cli/mcp-daemon-run.js')
  } catch {
    return false
  }
}

export function status() {
  const record = readPidRecord()
  const pid = record?.pid || null
  const running = isRunning(pid)
  const owned = running && isMcpDaemonProcess(pid)
  return { ok: true, running: owned, pid, owned, port: record?.port, accountMode: record?.accountMode, pidPath: MCP_DAEMON_PID_PATH, logPath: MCP_DAEMON_LOG_PATH }
}

export function start({ port, accountMode } = {}) {
  const current = status()
  if (current.running) return { ...current, alreadyRunning: true }

  const out = openSync(MCP_DAEMON_LOG_PATH, 'a')
  const child = spawn(process.execPath, [MCP_DAEMON_SCRIPT], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...(port ? { TSB_MCP_DAEMON_PORT: String(port) } : {}), ...(accountMode ? { TSB_MCP_DAEMON_ACCOUNT_MODE: accountMode } : {}) },
  })
  child.unref()
  closeSync(out)
  writeFileSync(MCP_DAEMON_PID_PATH, JSON.stringify({ pid: child.pid, port, accountMode, startedAt: new Date().toISOString() }) + '\n')

  return { ok: true, running: true, pid: child.pid, port, accountMode, pidPath: MCP_DAEMON_PID_PATH, logPath: MCP_DAEMON_LOG_PATH }
}

export function stop() {
  const record = readPidRecord()
  const pid = record?.pid || null
  if (!pid) return { ok: true, running: false, stopped: false, reason: 'no-pid-file' }
  if (!isRunning(pid)) {
    unlinkSync(MCP_DAEMON_PID_PATH)
    return { ok: true, running: false, stopped: false, reason: 'stale-pid-file' }
  }
  if (!isMcpDaemonProcess(pid)) {
    unlinkSync(MCP_DAEMON_PID_PATH)
    return { ok: false, running: false, stopped: false, reason: 'pid-not-mcp-daemon', pid, retryable: false }
  }
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 50 && isRunning(pid); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  if (isRunning(pid)) return { ok: false, running: true, stopped: false, reason: 'mcp-daemon-did-not-stop', pid, retryable: true }
  if (existsSync(MCP_DAEMON_PID_PATH)) unlinkSync(MCP_DAEMON_PID_PATH)
  return { ok: true, running: false, stopped: true, pid }
}

export function restart(opts) {
  const stopped = stop()
  if (!stopped.ok) return stopped
  return start(opts)
}

export function logs({ lines = 80 } = {}) {
  if (!existsSync(MCP_DAEMON_LOG_PATH)) return { ok: true, logPath: MCP_DAEMON_LOG_PATH, text: '' }
  const all = readFileSync(MCP_DAEMON_LOG_PATH, 'utf8').split('\n')
  return { ok: true, logPath: MCP_DAEMON_LOG_PATH, text: all.slice(-lines).join('\n') }
}
