// Orchestrates ACP-driven Slack thread sessions (PLAN: ACP thread sessions,
// D23/D24/D25). One Slack thread == one ACP session, multiplexed on top of
// core/acp-client.js's per-backend persistent connections.

import { getBackendConnection, registerSession, unregisterSession } from './acp-client.js'
import { getBackend, DEFAULT_BACKEND } from './acp-backends.js'
import { resolveRepoPath } from './repos.js'
import { createFsHandlers } from './acp-fs.js'
import { createTerminalHandlers } from './acp-terminal.js'
import { createAgentSession } from './agent-sessions.js'
import { startProgress, updateProgress, finishProgress } from './progress.js'
import { ask } from './ask.js'

const DEBOUNCE_MS = 1500
const MAX_RENDERED_CHARS = 2800

const activeSessionsByKey = new Map()

function sessionKey(channel, threadTs) {
  return `${channel}:${threadTs}`
}

// Shared by every trigger (slash command, app-mention keyword, message
// shortcut free-text) — `--backend name` / `--repo name` flags anywhere in
// the text, remaining words are the task.
export function parseAgentSessionCommand(text) {
  const tokens = (text || '').trim().split(/\s+/).filter(Boolean)
  let backendName = DEFAULT_BACKEND
  let repoName
  const remaining = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--backend' && tokens[i + 1]) {
      backendName = tokens[++i]
    } else if (tokens[i] === '--repo' && tokens[i + 1]) {
      repoName = tokens[++i]
    } else {
      remaining.push(tokens[i])
    }
  }
  return { backendName, repoName, task: remaining.join(' ').trim() }
}

// D24 — session-start gate. Owner is always allowed; everyone else needs
// to be in the explicit allowlist. Never gated by channel membership alone.
export function isAllowedToStartSession(config, userId) {
  if (!userId) return false
  if (config.owner?.slackUserId === userId) return true
  return (config.agentSessions?.allowedUsers || []).includes(userId)
}

async function handlePermissionRequest({ env, dbPath, channel, threadTs, requestedBy, params }) {
  const optionLabels = params.options.map(option => option.name)
  const result = await ask({
    botToken: env.SLACK_BOT_TOKEN,
    userId: requestedBy,
    question: `Permission requested: ${params.toolCall.title || params.toolCall.toolCallId}`,
    kind: 'approval',
    options: optionLabels,
    dbPath,
    channel,
    threadTs,
  })
  if (!result.ok) return { outcome: { outcome: 'cancelled' } }
  const chosen = params.options.find(option => option.name === result.answer?.label)
  if (!chosen) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId: chosen.optionId } }
}

function describeUpdate(update) {
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    return { text: update.content.text }
  }
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    return { text: `\n[tool: ${update.title || update.toolCallId}${update.status ? ` — ${update.status}` : ''}]` }
  }
  return null
}

// Runs one session/prompt turn, streaming session/update notifications into
// a single debounced progress-message edit rather than one edit per chunk
// (no rate-limit-aware coalescing exists in core/progress.js itself — this
// is that missing piece, kept here rather than in progress.js).
async function runPromptTurn(entry, promptText) {
  entry.accumulatedText = ''
  let flushTimer = null

  function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      updateProgress({
        token: entry.env.SLACK_BOT_TOKEN,
        channel: entry.channel,
        ts: entry.progressTs,
        label: `Agent session (${entry.backend.name} · ${entry.repoName})`,
        detail: entry.accumulatedText.slice(-MAX_RENDERED_CHARS) || 'working…',
        config: entry.config,
      })
    }, DEBOUNCE_MS)
  }

  entry.activeSession.prompt(promptText).catch(() => {})

  for (;;) {
    const message = await entry.activeSession.nextUpdate()
    if (message.kind === 'stop') {
      if (flushTimer) clearTimeout(flushTimer)
      await finishProgress({
        token: entry.env.SLACK_BOT_TOKEN,
        channel: entry.channel,
        ts: entry.progressTs,
        label: `Agent session (${entry.backend.name} · ${entry.repoName})`,
        detail: entry.accumulatedText.slice(-MAX_RENDERED_CHARS) || message.response.stopReason,
        ok: message.response.stopReason === 'end_turn',
        config: entry.config,
      })
      return message.response
    }
    const described = describeUpdate(message.notification.update)
    if (described) {
      entry.accumulatedText += described.text
      scheduleFlush()
    }
  }
}

export async function startAgentSession({ env, config, dbPath, channel, threadTs, backendName, repoName, task, requestedBy }) {
  if (!isAllowedToStartSession(config, requestedBy)) {
    return { ok: false, error: 'not-allowed-to-start-agent-session', retryable: false }
  }
  const backend = getBackend(backendName)
  if (!backend) return { ok: false, error: 'unknown-backend', retryable: false }

  const repo = resolveRepoPath(repoName)
  if (!repo.ok) return repo

  // Post first, then anchor everything (the DB row, the in-memory session
  // key, future thread-reply routing) on the RESULTING message's ts when no
  // threadTs was given — that new message's ts is what Slack actually uses
  // as thread_ts for any reply built on it, not the (absent) input value.
  const progressPost = await startProgress({
    token: env.SLACK_BOT_TOKEN,
    channel,
    label: `Agent session (${backend.name} · ${repo.name})`,
    detail: 'starting…',
    threadTs,
    config,
  })
  if (!progressPost.ok) return progressPost
  const anchorThreadTs = threadTs || progressPost.ts

  const created = createAgentSession({
    dbPath,
    config,
    source: 'slack',
    slackChannel: channel,
    slackThreadTs: anchorThreadTs,
    kind: 'acp-session',
    metadata: { backend: backend.name, repoName: repo.name, repoPath: repo.path, requestedBy },
  })
  if (!created.ok) return created

  const { connection, sessions } = await getBackendConnection(backend)
  const activeSession = await connection.agent.buildSession(repo.path).start()

  registerSession(sessions, activeSession.sessionId, {
    fsHandlers: createFsHandlers(repo.path),
    terminalHandlers: createTerminalHandlers(repo.path),
    onPermissionRequest: params => handlePermissionRequest({ env, dbPath, channel, threadTs: anchorThreadTs, requestedBy, params }),
  })

  const entry = { activeSession, backend, sessions, repoName: repo.name, progressTs: progressPost.ts, channel, env, config, accumulatedText: '' }
  activeSessionsByKey.set(sessionKey(channel, anchorThreadTs), entry)

  const response = await runPromptTurn(entry, task)
  return { ok: true, sessionId: activeSession.sessionId, channel, threadTs: anchorThreadTs, stopReason: response.stopReason }
}

export async function routeThreadReply({ channel, threadTs, text }) {
  const entry = activeSessionsByKey.get(sessionKey(channel, threadTs))
  if (!entry) return { ok: false, error: 'no-active-session-for-thread', retryable: false }
  const response = await runPromptTurn(entry, text)
  return { ok: true, stopReason: response.stopReason }
}

export function hasActiveSession(channel, threadTs) {
  return activeSessionsByKey.has(sessionKey(channel, threadTs))
}

export function closeAgentSession(channel, threadTs) {
  const key = sessionKey(channel, threadTs)
  const entry = activeSessionsByKey.get(key)
  if (!entry) return { ok: false, error: 'no-active-session-for-thread', retryable: false }
  entry.activeSession.dispose()
  unregisterSession(entry.sessions, entry.activeSession.sessionId)
  activeSessionsByKey.delete(key)
  return { ok: true }
}
