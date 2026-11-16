// Listener daemon control (PLAN D75). State (pid + log) lives under
// `<TSB_HOME>/run/<name>/`, never inside the installed package: `npm update`
// wipes the package folder, and one install can now run several listeners.
//
//   name 'all'      -> one supervisor process serving every listenable account
//   name '<account>'-> a single-account listener for that registered account
//   name 'default'  -> the registry's default account (the pre-D75 behaviour)

import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const LISTENER_SCRIPT = join(repoRoot, 'cli/listen.js')

export function runRoot() {
  return join(process.env.TSB_HOME || join(homedir(), '.team-slack-bridge'), 'run')
}

function safeName(name) {
  return String(name || 'default').replace(/[^A-Za-z0-9._-]/g, '_')
}

export function runPaths(name = 'default') {
  const dir = join(runRoot(), safeName(name))
  return { dir, pidPath: join(dir, 'listener.pid'), logPath: join(dir, 'listener.log') }
}

function readPidRecord(pidPath) {
  if (!existsSync(pidPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(pidPath, 'utf8').trim())
    return Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed : null
  } catch {
    return null
  }
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

export function isListenerProcess(pid) {
  if (!isRunning(pid)) return false
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes('cli/listen.js')
  } catch {
    return false
  }
}

export function status(name = 'default') {
  const { pidPath, logPath } = runPaths(name)
  const record = readPidRecord(pidPath)
  const pid = record?.pid || null
  const running = Boolean(record) && isRunning(pid) && isListenerProcess(pid)
  return { ok: true, name, running, pid, pidPath, logPath }
}

export function statusAll() {
  const root = runRoot()
  const names = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : []
  return { ok: true, listeners: names.map(name => status(name)) }
}

function listenerArgs(name) {
  if (name === 'all') return [LISTENER_SCRIPT, '--all']
  if (name === 'default') return [LISTENER_SCRIPT]
  return [LISTENER_SCRIPT, '--account', name]
}

export function start(name = 'default') {
  const current = status(name)
  if (current.running) return { ...current, alreadyRunning: true }
  // Two listeners on one Slack app split its events between them (Slack picks a
  // connection per event), so an 'all' supervisor must not coexist with a
  // single-account listener, and vice versa.
  const others = statusAll().listeners.filter(item => item.running && item.name !== safeName(name))
  if (others.length && (name === 'all' || others.some(item => item.name === 'all'))) {
    return { ok: false, error: 'another-listener-running', running: others.map(item => item.name), retryable: false }
  }

  const { dir, pidPath, logPath } = runPaths(name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const out = openSync(logPath, 'a')
  const args = listenerArgs(name)
  const child = spawn(process.execPath, args, { cwd: repoRoot, detached: true, stdio: ['ignore', out, out] })
  child.unref()
  closeSync(out)
  writeFileSync(pidPath, JSON.stringify({ pid: child.pid, command: [process.execPath, ...args], startedAt: new Date().toISOString() }) + '\n')
  return { ok: true, name, running: true, pid: child.pid, pidPath, logPath }
}

export function stop(name = 'default') {
  const { pidPath } = runPaths(name)
  const record = readPidRecord(pidPath)
  const pid = record?.pid || null
  if (!pid) return { ok: true, name, running: false, stopped: false, reason: 'no-pid-file' }
  if (!isRunning(pid)) {
    unlinkSync(pidPath)
    return { ok: true, name, running: false, stopped: false, reason: 'stale-pid-file' }
  }
  if (!isListenerProcess(pid)) {
    unlinkSync(pidPath)
    return { ok: false, name, running: false, stopped: false, reason: 'pid-not-listener', pid, retryable: false }
  }
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 50 && isRunning(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  if (isRunning(pid)) return { ok: false, name, running: true, stopped: false, reason: 'listener-did-not-stop', pid, retryable: true }
  if (existsSync(pidPath)) unlinkSync(pidPath)
  return { ok: true, name, running: false, stopped: true, pid }
}

// `start` run every minute from cron is idempotent, which is the
// recommended auto-restart; `restart` is the explicit one-shot.
export function restart(name = 'default') {
  const stopped = stop(name)
  if (!stopped.ok) return stopped
  return start(name)
}

export function logs({ name = 'default', lines = 80 } = {}) {
  const { logPath } = runPaths(name)
  if (!existsSync(logPath)) return { ok: true, name, logPath, text: '' }
  return { ok: true, name, logPath, text: readFileSync(logPath, 'utf8').split('\n').slice(-lines).join('\n') }
}
