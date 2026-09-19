// D34 — Away-mode flag file. When present, hooks route permission
// requests / stop decisions / notifications to Slack instead of the
// local terminal. Stores JSON so away mode can carry its own tuning
// without a config migration.

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

function rootHome() {
  return process.env.TSB_HOME || join(homedir(), '.team-slack-bridge')
}

export function getAwayFlagPath() {
  return join(rootHome(), '.away')
}

export function isAway() {
  const path = getAwayFlagPath()
  if (!existsSync(path)) return false
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (data.timeoutSeconds) {
      const elapsed = (Date.now() - new Date(data.since).getTime()) / 1000
      if (elapsed > data.timeoutSeconds) {
        try { unlinkSync(path) } catch {}
        return false
      }
    }
    return true
  } catch {
    return existsSync(path)
  }
}

export function getAwayConfig() {
  const path = getAwayFlagPath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { since: new Date().toISOString() }
  }
}

export function setAway(on, { timeoutSeconds, maxContinuations } = {}) {
  const path = getAwayFlagPath()
  if (!on) {
    try { unlinkSync(path) } catch {}
    return { ok: true, away: false }
  }
  mkdirSync(dirname(path), { recursive: true })
  const data = {
    since: new Date().toISOString(),
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
    ...(maxContinuations != null ? { maxContinuations } : {}),
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
  return { ok: true, away: true, path, ...data }
}
