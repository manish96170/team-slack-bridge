// D34/D39 — Harness-neutral hook decision logic, pure and testable, no
// stdio. Returns neutral verdicts ({ verdict, reason }) that adapters
// translate into harness-specific output. Each handler takes
// (input, { env, config, dbPath, harness, skipDaemonCheck }).

import { isAway, getAwayConfig } from './away.js'
import { shouldGate, failMode } from './away-policy.js'
import { ask } from './ask.js'
import { dm } from './dm.js'
import { status as daemonStatus } from '../listen/daemon.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

function rootHome() {
  return process.env.TSB_HOME || join(homedir(), '.team-slack-bridge')
}

function hooksDir() {
  return join(rootHome(), 'hooks')
}

function validateLabel(label) {
  if (typeof label === 'string' && label.includes(':')) {
    throw new Error(`label must not contain ":" (got "${label}") — the listener splits on it for correlation`)
  }
}

function truncate(text, maxLen = 200) {
  if (!text || text.length <= maxLen) return text
  return text.slice(0, maxLen) + '...'
}

function describeToolCall(input) {
  const parts = []
  const toolName = input.tool_name || input.tool || 'unknown tool'
  parts.push(`\`${toolName}\``)
  if (input.cwd) parts.push(`in \`${basename(input.cwd)}\``)
  if (input.agent_type) parts.push(`(${input.agent_type}${input.agent_id ? ` #${input.agent_id}` : ''})`)
  const toolInput = input.tool_input || input.args
  if (toolInput) {
    const summary = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
    parts.push(`\n\`\`\`\n${truncate(summary, 500)}\n\`\`\``)
  }
  return parts.join(' ')
}

function preflight(config, { skipDaemonCheck } = {}) {
  const ownerId = config?.owner?.slackUserId
  if (!ownerId) return { skip: true, reason: 'no-owner-configured' }
  if (!skipDaemonCheck) {
    const daemon = daemonStatus()
    if (!daemon.running) return { failOpen: true, reason: 'listener-not-running' }
  }
  return { ok: true, ownerId }
}

function getTimeout(config) {
  return config?.awayMode?.hookTimeoutSeconds || 300
}

// --- PreToolUse / tool.execute.before ---

export async function preToolUse(input, { env, config, dbPath, harness = 'claude', skipDaemonCheck } = {}) {
  if (!isAway()) return { verdict: 'skip' }

  const toolName = input.tool_name || input.tool
  if (!shouldGate(toolName, { config })) return { verdict: 'skip' }

  const pre = preflight(config, { skipDaemonCheck })
  if (pre.skip) return { verdict: 'skip', reason: pre.reason }
  // D35/D39 — daemon-down fail mode depends on the harness
  if (pre.failOpen) {
    const mode = failMode(harness)
    return mode === 'defer'
      ? { verdict: 'defer', reason: pre.reason }
      : { verdict: 'deny', reason: `Bridge timeout (listener not running) — ${pre.reason}` }
  }

  const question = `Permission requested: ${describeToolCall(input)}`
  validateLabel('Approve')
  validateLabel('Deny')

  const result = await ask({
    botToken: env.SLACK_BOT_TOKEN,
    userId: pre.ownerId,
    question,
    kind: 'approval',
    options: ['Approve', 'Deny'],
    dbPath,
    timeoutSeconds: getTimeout(config),
  })

  if (result.ok && result.answer?.label === 'Approve') {
    return { verdict: 'allow', reason: 'Approved via Slack' }
  }
  if (result.ok && result.answer?.label === 'Deny') {
    return { verdict: 'deny', reason: 'Denied via Slack' }
  }
  // D35/D39 — timeout/error fail mode depends on the harness
  const mode = failMode(harness)
  return mode === 'defer'
    ? { verdict: 'defer', reason: result.error || 'no-answer' }
    : { verdict: 'deny', reason: `Bridge timeout — no answer received (${result.error || 'timeout'})` }
}

// --- PreCompact / experimental.session.compacting ---
// Observational only on Claude (no blocking mechanism).
// On OpenCode, experimental.session.compacting may differ — treat as
// informational for now (D38 out-of-scope note).

export async function preCompact(input, { env, config, dbPath } = {}) {
  if (!isAway()) return { verdict: 'skip' }
  if (input.trigger !== 'auto') return { verdict: 'skip' }
  const ownerId = config?.owner?.slackUserId
  if (!ownerId) return { verdict: 'skip' }

  await dm({
    botToken: env.SLACK_BOT_TOKEN,
    userId: ownerId,
    text: 'Auto-compaction is about to run on your session (informational only).',
    dbPath,
  })
  return { verdict: 'ok' }
}

// --- Stop / session.idle ---

function stopCounterPath(sessionId) {
  return join(hooksDir(), `stop-${sessionId}.json`)
}

function readStopCounter(sessionId) {
  const path = stopCounterPath(sessionId)
  if (!existsSync(path)) return 0
  try {
    return JSON.parse(readFileSync(path, 'utf8')).count || 0
  } catch {
    return 0
  }
}

function incrementStopCounter(sessionId) {
  const dir = hooksDir()
  mkdirSync(dir, { recursive: true })
  const path = stopCounterPath(sessionId)
  const count = readStopCounter(sessionId) + 1
  const tmpPath = `${path}.${process.pid}.tmp`
  writeFileSync(tmpPath, JSON.stringify({ count, updatedAt: new Date().toISOString() }) + '\n')
  renameSync(tmpPath, path)
  return count
}

export async function stop(input, { env, config, dbPath, harness = 'claude', skipDaemonCheck } = {}) {
  if (!isAway()) return { verdict: 'skip' }
  const pre = preflight(config, { skipDaemonCheck })
  if (pre.skip || pre.failOpen) return { verdict: 'allow', reason: pre.reason || 'skipped' }

  const awayConfig = getAwayConfig()
  const maxContinuations = config?.awayMode?.maxContinuations ?? awayConfig?.maxContinuations ?? 3
  const sessionId = input.session_id || 'unknown'
  const currentCount = readStopCounter(sessionId)

  if (currentCount >= maxContinuations) {
    await dm({
      botToken: env.SLACK_BOT_TOKEN,
      userId: pre.ownerId,
      text: `Session reached the continuation cap (${maxContinuations}). Allowing it to stop.`,
      dbPath,
    })
    return { verdict: 'allow', reason: 'continuation-cap-reached' }
  }

  const result = await ask({
    botToken: env.SLACK_BOT_TOKEN,
    userId: pre.ownerId,
    question: 'Session wants to stop. What should it do?\n\nReply `done` to let it stop, or type an instruction to continue.',
    kind: 'question',
    dbPath,
    timeoutSeconds: getTimeout(config),
  })

  if (!result.ok) return { verdict: 'allow', reason: result.error || 'no-answer' }

  const answer = (result.answer?.text || '').trim().toLowerCase()
  if (!answer || answer === 'done' || answer === 'stop') {
    return { verdict: 'allow', reason: 'user-said-done' }
  }

  incrementStopCounter(sessionId)
  // D36 — block. Adapters translate: Claude exits 2 + stderr, OpenCode
  // returns the instruction text for continuation.
  return { verdict: 'block', reason: result.answer.text }
}

// --- Notification ---

export async function notification(input, { env, config, dbPath } = {}) {
  if (!isAway()) return { verdict: 'skip' }
  const ownerId = config?.owner?.slackUserId
  if (!ownerId) return { verdict: 'skip' }

  const type = input.notification_type || input.event || 'notification'
  const message = input.message || input.notification_type || input.event || ''
  const text = `[${type}] ${message}`

  await dm({
    botToken: env.SLACK_BOT_TOKEN,
    userId: ownerId,
    text,
    dbPath,
  })
  return { verdict: 'ok' }
}
