// D34 — All hook decision logic, pure and testable, no stdio.
// One exported handler per Claude Code hook event, each taking
// (input, {env, config, dbPath}) and returning a plain result object.
// cli/hook.js is the thin dispatcher that reads stdin, calls these,
// and handles exit codes.

import { isAway, getAwayConfig } from './away.js'
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
  if (input.tool_name) parts.push(`\`${input.tool_name}\``)
  if (input.cwd) parts.push(`in \`${basename(input.cwd)}\``)
  if (input.agent_type) parts.push(`(${input.agent_type}${input.agent_id ? ` #${input.agent_id}` : ''})`)
  if (input.tool_input) {
    const summary = typeof input.tool_input === 'string' ? input.tool_input : JSON.stringify(input.tool_input)
    parts.push(`\n\`\`\`\n${truncate(summary, 500)}\n\`\`\``)
  }
  return parts.join(' ') || 'unknown tool'
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

// --- PreToolUse ---

export async function preToolUse(input, { env, config, dbPath, skipDaemonCheck } = {}) {
  if (!isAway()) return { skip: true }
  const pre = preflight(config, { skipDaemonCheck })
  if (pre.skip) return pre
  if (pre.failOpen) return { decision: 'ignore', reason: pre.reason }

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
    timeoutSeconds: config.hookTimeoutSeconds || 300,
  })

  if (result.ok && result.answer?.label === 'Approve') {
    return { decision: 'allow', reason: 'Approved via Slack' }
  }
  if (result.ok && result.answer?.label === 'Deny') {
    return { decision: 'deny', reason: 'Denied via Slack' }
  }
  // D35 — fail open: return a marker that cli/hook.js treats as "no
  // JSON output, just exit 0" — falling through to the normal local
  // prompt. "ignore" is not a valid permissionDecision value in the
  // Claude Code hook contract; the correct fail-open is no output at all.
  return { failOpen: true, reason: result.error || 'no-answer' }
}

// --- PreCompact ---
// Verified against Claude Code docs: PreCompact is observational only.
// There is no compactionDecision field and exit 2 does NOT prevent
// compaction. All we can do is send a Slack notification that it's
// happening, so the user knows.

export async function preCompact(input, { env, config, dbPath, skipDaemonCheck } = {}) {
  if (!isAway()) return { skip: true }
  if (input.trigger !== 'auto') return { skip: true }
  const ownerId = config?.owner?.slackUserId
  if (!ownerId) return { skip: true }

  await dm({
    botToken: env.SLACK_BOT_TOKEN,
    userId: ownerId,
    text: 'Auto-compaction is about to run on your session (informational — compaction cannot be blocked by hooks).',
    dbPath,
  })
  return { ok: true }
}

// --- Stop ---

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

// Atomic-ish via write-to-temp + rename — two concurrent stop hooks for
// the same session can still race (one's rename overwrites the other's),
// but the worst case is a lost increment (one fewer continuation than the
// cap), not a doubled block or a crash. A proper advisory lock would fix
// this fully but adds complexity disproportionate to the risk, since
// concurrent stops for the same session are rare in practice.
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

export async function stop(input, { env, config, dbPath, skipDaemonCheck } = {}) {
  if (!isAway()) return { skip: true }
  const pre = preflight(config, { skipDaemonCheck })
  if (pre.skip || pre.failOpen) return { allow: true, reason: pre.reason || 'skipped' }

  const awayConfig = getAwayConfig()
  const maxContinuations = awayConfig?.maxContinuations ?? 3
  const sessionId = input.session_id || 'unknown'
  const currentCount = readStopCounter(sessionId)

  if (currentCount >= maxContinuations) {
    await dm({
      botToken: env.SLACK_BOT_TOKEN,
      userId: pre.ownerId,
      text: `Session reached the continuation cap (${maxContinuations}). Allowing it to stop.`,
      dbPath,
    })
    return { allow: true, reason: 'continuation-cap-reached' }
  }

  const result = await ask({
    botToken: env.SLACK_BOT_TOKEN,
    userId: pre.ownerId,
    question: `Session wants to stop. What should it do?\n\nReply \`done\` to let it stop, or type an instruction to continue.`,
    kind: 'question',
    dbPath,
    timeoutSeconds: config.hookTimeoutSeconds || 300,
  })

  if (!result.ok) return { allow: true, reason: result.error || 'no-answer' }

  const answer = (result.answer?.text || '').trim().toLowerCase()
  if (!answer || answer === 'done' || answer === 'stop') {
    return { allow: true, reason: 'user-said-done' }
  }

  incrementStopCounter(sessionId)
  // D36 — block via exit 2 + stderr. cli/hook.js reads this and exits 2.
  return { block: true, reason: result.answer.text }
}

// --- Notification ---

export async function notification(input, { env, config, dbPath }) {
  if (!isAway()) return { skip: true }
  const ownerId = config?.owner?.slackUserId
  if (!ownerId) return { skip: true }

  const type = input.notification_type || 'notification'
  const message = input.message || input.notification_type || ''
  const text = `[${type}] ${message}`

  await dm({
    botToken: env.SLACK_BOT_TOKEN,
    userId: ownerId,
    text,
    dbPath,
  })
  return { ok: true }
}
