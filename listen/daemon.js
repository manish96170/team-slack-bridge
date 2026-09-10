import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

export const LISTENER_PID_PATH = join(repoRoot, '.listener.pid')
export const LISTENER_LOG_PATH = join(repoRoot, '.listener.log')
const LISTENER_SCRIPT = join(repoRoot, 'cli/listen.js')

function readPidRecord() {
  if (!existsSync(LISTENER_PID_PATH)) return null
  const raw = readFileSync(LISTENER_PID_PATH, 'utf8').trim()
  try {
    const parsed = JSON.parse(raw)
    return Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed : null
  } catch {
    const pid = Number(raw)
    return Number.isInteger(pid) && pid > 0 ? { pid, legacy: true } : null
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

export function isListenerProcess(pid) {
  if (!isRunning(pid)) return false
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
    return command.includes(LISTENER_SCRIPT) || command.includes('cli/listen.js')
  } catch {
    return false
  }
}

export function status() {
  const record = readPidRecord()
  const pid = record?.pid || null
  const running = isRunning(pid)
  const metadataMatches = !!record && !record.legacy && Array.isArray(record.command) && record.command[1] === LISTENER_SCRIPT
  const owned = running && (metadataMatches || record.legacy) && isListenerProcess(pid)
  return { ok: true, running: owned, pid, owned, pidPath: LISTENER_PID_PATH, logPath: LISTENER_LOG_PATH }
}

export function start() {
  const current = status()
  if (current.running) return { ...current, alreadyRunning: true }

  const out = openSync(LISTENER_LOG_PATH, 'a')
  const child = spawn(process.execPath, [LISTENER_SCRIPT], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', out, out],
  })
  child.unref()
  closeSync(out)
  writeFileSync(LISTENER_PID_PATH, JSON.stringify({ pid: child.pid, command: [process.execPath, LISTENER_SCRIPT], startedAt: new Date().toISOString() }) + '\n')

  return { ok: true, running: true, pid: child.pid, pidPath: LISTENER_PID_PATH, logPath: LISTENER_LOG_PATH }
}

export function stop() {
  const record = readPidRecord()
  const pid = record?.pid || null
  if (!pid) return { ok: true, running: false, stopped: false, reason: 'no-pid-file' }
  if (!isRunning(pid)) {
    unlinkSync(LISTENER_PID_PATH)
    return { ok: true, running: false, stopped: false, reason: 'stale-pid-file' }
  }
  const metadataMatches = !record.legacy && Array.isArray(record.command) && record.command[1] === LISTENER_SCRIPT
  if ((!metadataMatches && !record.legacy) || !isListenerProcess(pid)) {
    unlinkSync(LISTENER_PID_PATH)
    return { ok: false, running: false, stopped: false, reason: 'pid-not-listener', pid, retryable: false }
  }
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 50 && isRunning(pid); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  if (isRunning(pid)) return { ok: false, running: true, stopped: false, reason: 'listener-did-not-stop', pid, retryable: true }
  if (existsSync(LISTENER_PID_PATH)) unlinkSync(LISTENER_PID_PATH)
  return { ok: true, running: false, stopped: true, pid }
}

// A cron-friendly restart: `node cli/daemon.js start` run every minute is
// already idempotent (start() no-ops if the PID is alive) and is the
// recommended way to get auto-restart-on-crash without a second supervisor
// process watching this one. `restart()` is the explicit one-shot version.
export function restart() {
  const stopped = stop()
  if (!stopped.ok) return stopped
  return start()
}

export function logs({ lines = 80 } = {}) {
  if (!existsSync(LISTENER_LOG_PATH)) return { ok: true, logPath: LISTENER_LOG_PATH, text: '' }
  const all = readFileSync(LISTENER_LOG_PATH, 'utf8').split('\n')
  return { ok: true, logPath: LISTENER_LOG_PATH, text: all.slice(-lines).join('\n') }
}
