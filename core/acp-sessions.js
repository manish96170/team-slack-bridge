// Orchestrates ACP-driven Slack thread sessions (PLAN: ACP thread sessions,
// D23/D24/D25). One Slack thread == one ACP session, multiplexed on top of
// core/acp-client.js's per-backend persistent connections.

import { methods } from '@agentclientprotocol/sdk'
import { getBackendConnection, registerSession, unregisterSession, createUpdateQueue } from './acp-client.js'
import { getBackend, DEFAULT_BACKEND } from './acp-backends.js'
import { resolveRepoPath } from './repos.js'
import { createFsHandlers } from './acp-fs.js'
import { createTerminalHandlers } from './acp-terminal.js'
import { createAgentSession, findAgentSessionBySlackThread, updateAgentSession } from './agent-sessions.js'
import { startProgress, updateProgress, finishProgress } from './progress.js'
import { ask } from './ask.js'

const DEBOUNCE_MS = 1500
const MAX_RENDERED_CHARS = 2800

const activeSessionsByKey = new Map()

function sessionKey(channel, threadTs) {
  return `${channel}:${threadTs}`
}

// Shared by every trigger (slash command, app-mention keyword, message
// shortcut free-text) — `--backend name` / `--repo name` / `--model name`
// flags anywhere in the text, remaining words are the task.
export function parseAgentSessionCommand(text) {
  const tokens = (text || '').trim().split(/\s+/).filter(Boolean)
  let backendName = DEFAULT_BACKEND
  let repoName
  let modelName
  const remaining = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--backend' && tokens[i + 1]) {
      backendName = tokens[++i]
    } else if (tokens[i] === '--repo' && tokens[i + 1]) {
      repoName = tokens[++i]
    } else if (tokens[i] === '--model' && tokens[i + 1]) {
      modelName = tokens[++i]
    } else {
      remaining.push(tokens[i])
    }
  }
  return { backendName, repoName, modelName, task: remaining.join(' ').trim() }
}

// ACP's session/new response can advertise selectable config options
// (schema: NewSessionResponse.configOptions) — a "model" category option is
// the protocol-native way to pick a model, discovered at runtime rather than
// hardcoded per backend (each backend's actual option id/choices are its
// own business; this just looks for whichever one is tagged "model").
function flattenSelectOptions(options) {
  const flat = []
  for (const entry of options || []) {
    if (entry.group) flat.push(...entry.options)
    else flat.push(entry)
  }
  return flat
}

function findModelConfigOption(configOptions) {
  return (configOptions || []).find(option => option.category === 'model' && option.options)
}

export async function applyModelSelection({ connection, activeSession, modelName }) {
  const option = findModelConfigOption(activeSession.newSessionResponse?.configOptions)
  if (!option) return { ok: false, error: 'backend-does-not-advertise-a-model-selector', retryable: false }
  const choices = flattenSelectOptions(option.options)
  const needle = modelName.toLowerCase()
  const match = choices.find(choice => choice.value.toLowerCase() === needle || choice.name.toLowerCase() === needle)
  if (!match) return { ok: false, error: 'unknown-model', available: choices.map(choice => choice.name), retryable: false }
  await connection.agent.request(methods.agent.session.setConfigOption, {
    sessionId: activeSession.sessionId,
    configId: option.id,
    value: match.value,
  })
  return { ok: true, model: match.name }
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

// The public SDK only builds an ActiveSession-shaped helper (queued
// updates, prompt() that also enqueues its own completion) for session/new
// — there's no equivalent public builder for session/load or
// session/resume (PLAN: ACP thread sessions, Phase 4). This is the minimal
// hand-rolled equivalent, fed by core/acp-client.js's global session/update
// tap via the same updateQueue registered for this sessionId.
function createResumedSessionHandle({ connection, sessionId, response, updateQueue }) {
  return {
    sessionId,
    newSessionResponse: response,
    async prompt(text) {
      const promptResponse = await connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] })
      updateQueue.push({ kind: 'stop', response: promptResponse })
      return promptResponse
    },
    nextUpdate() {
      return updateQueue.next()
    },
    dispose() {},
  }
}

// Tries to reconnect an already-persisted ACP session (e.g. after the
// listener process restarted and lost the in-memory entry) rather than
// treating the thread as having no session at all. Tries session/resume
// first (no history replay — cleaner), then session/load, based on
// whichever capability the backend actually advertised at initialize time.
// Returns the same {ok:false, error:'no-active-session-for-thread'} shape
// as "there was never a session here" on any failure, so callers degrade
// to normal message handling exactly as they already do today.
async function tryResumeSession({ env, config, dbPath, channel, threadTs, requestedBy }) {
  const persisted = findAgentSessionBySlackThread({ dbPath, slackChannel: channel, slackThreadTs: threadTs })
  if (!persisted || persisted.kind !== 'acp-session' || persisted.status === 'closed') {
    return { ok: false, error: 'no-active-session-for-thread', retryable: false }
  }
  if (!isAllowedToStartSession(config, requestedBy)) {
    return { ok: false, error: 'no-active-session-for-thread', retryable: false }
  }
  const { backend: backendName, repoName, repoPath, acpSessionId, model } = persisted.metadata || {}
  const backend = getBackend(backendName)
  if (!backend || !acpSessionId || !repoPath) return { ok: false, error: 'no-active-session-for-thread', retryable: false }

  const { connection, sessions, initializeResponse } = await getBackendConnection(backend)
  const caps = initializeResponse?.agentCapabilities
  let response
  if (caps?.sessionCapabilities?.resume) {
    response = await connection.agent.request(methods.agent.session.resume, { sessionId: acpSessionId, cwd: repoPath })
  } else if (caps?.loadSession) {
    response = await connection.agent.request(methods.agent.session.load, { sessionId: acpSessionId, cwd: repoPath, mcpServers: [] })
  } else {
    return { ok: false, error: 'no-active-session-for-thread', retryable: false }
  }

  const updateQueue = createUpdateQueue()
  registerSession(sessions, acpSessionId, {
    fsHandlers: createFsHandlers(repoPath),
    terminalHandlers: createTerminalHandlers(repoPath),
    onPermissionRequest: params => handlePermissionRequest({ env, dbPath, channel, threadTs, requestedBy, params }),
    updateQueue,
  })
  const activeSession = createResumedSessionHandle({ connection, sessionId: acpSessionId, response, updateQueue })

  const progressPost = await startProgress({
    token: env.SLACK_BOT_TOKEN,
    channel,
    label: `Agent session (${backend.name}${model ? ` · ${model}` : ''} · ${repoName})`,
    detail: 'reconnected after a restart — continuing…',
    threadTs,
    config,
  })
  if (!progressPost.ok) {
    unregisterSession(sessions, acpSessionId)
    return progressPost
  }

  const entry = { activeSession, backend, sessions, repoName, model, agentSessionRowId: persisted.id, progressTs: progressPost.ts, channel, env, config, accumulatedText: '' }
  activeSessionsByKey.set(sessionKey(channel, threadTs), entry)
  updateAgentSession({ dbPath, id: persisted.id, status: 'active' })
  return { ok: true, entry }
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

function sessionLabel(entry) {
  return `Agent session (${entry.backend.name}${entry.model ? ` · ${entry.model}` : ''} · ${entry.repoName})`
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
        label: sessionLabel(entry),
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
        label: sessionLabel(entry),
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

export async function startAgentSession({ env, config, dbPath, channel, threadTs, backendName, repoName, modelName, task, requestedBy }) {
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

  const { connection, sessions } = await getBackendConnection(backend)
  const activeSession = await connection.agent.buildSession(repo.path).start()

  let appliedModel
  if (modelName) {
    const applied = await applyModelSelection({ connection, activeSession, modelName })
    if (!applied.ok) {
      activeSession.dispose()
      await finishProgress({
        token: env.SLACK_BOT_TOKEN,
        channel,
        ts: progressPost.ts,
        label: `Agent session (${backend.name} · ${repo.name})`,
        detail: `Could not start: ${applied.error}${applied.available ? ` (available: ${applied.available.join(', ')})` : ''}`,
        ok: false,
        config,
      })
      return applied
    }
    appliedModel = applied.model
  }

  const created = createAgentSession({
    dbPath,
    config,
    source: 'slack',
    slackChannel: channel,
    slackThreadTs: anchorThreadTs,
    kind: 'acp-session',
    // acpSessionId is what makes resume-after-restart (Phase 4) possible —
    // without it, a restarted listener has no way to reconnect this thread
    // to the agent's own persisted conversation state.
    metadata: { backend: backend.name, repoName: repo.name, repoPath: repo.path, requestedBy, model: appliedModel, acpSessionId: activeSession.sessionId },
  })
  if (!created.ok) {
    activeSession.dispose()
    return created
  }

  registerSession(sessions, activeSession.sessionId, {
    fsHandlers: createFsHandlers(repo.path),
    terminalHandlers: createTerminalHandlers(repo.path),
    onPermissionRequest: params => handlePermissionRequest({ env, dbPath, channel, threadTs: anchorThreadTs, requestedBy, params }),
  })

  const entry = {
    activeSession,
    backend,
    sessions,
    repoName: repo.name,
    model: appliedModel,
    agentSessionRowId: created.session.id,
    progressTs: progressPost.ts,
    channel,
    env,
    config,
    accumulatedText: '',
  }
  activeSessionsByKey.set(sessionKey(channel, anchorThreadTs), entry)

  const response = await runPromptTurn(entry, task)
  return { ok: true, sessionId: activeSession.sessionId, channel, threadTs: anchorThreadTs, stopReason: response.stopReason }
}

// Callers (listen/socket.js) call this unconditionally for every thread
// reply — it's a cheap indexed DB lookup in the common case where a thread
// never had a session, and falls through to normal message handling
// exactly as before whenever it returns ok:false, whether that's "never had
// a session" or "had one but it's unresumable now".
export async function routeThreadReply({ env, config, dbPath, channel, threadTs, text, requestedBy }) {
  let entry = activeSessionsByKey.get(sessionKey(channel, threadTs))
  if (!entry) {
    const resumed = await tryResumeSession({ env, config, dbPath, channel, threadTs, requestedBy })
    if (!resumed.ok) return resumed
    entry = resumed.entry
  }
  const response = await runPromptTurn(entry, text)
  return { ok: true, stopReason: response.stopReason }
}

// Closing doesn't need to reconnect to the backend at all — it's pure local
// bookkeeping (drop the in-memory entry if any, mark the DB row closed) —
// so this also works for a session lost to a restart and never resumed,
// not just a currently-live one. Without the DB fallback, "close" on a
// not-yet-resumed session would fail even though the whole point is to
// make sure it never gets resumed later.
// Gated the same way as starting one (D24) — anyone in the channel could
// otherwise stop or close a session they didn't start.
export function closeAgentSession({ dbPath, config, channel, threadTs, requestedBy }) {
  if (!isAllowedToStartSession(config, requestedBy)) {
    return { ok: false, error: 'not-allowed-to-close-agent-session', retryable: false }
  }
  const key = sessionKey(channel, threadTs)
  const entry = activeSessionsByKey.get(key)
  if (entry) {
    entry.activeSession.dispose()
    unregisterSession(entry.sessions, entry.activeSession.sessionId)
    activeSessionsByKey.delete(key)
    if (entry.agentSessionRowId) updateAgentSession({ dbPath, id: entry.agentSessionRowId, status: 'closed' })
    return { ok: true }
  }
  const persisted = findAgentSessionBySlackThread({ dbPath, slackChannel: channel, slackThreadTs: threadTs })
  if (!persisted || persisted.kind !== 'acp-session' || persisted.status === 'closed') {
    return { ok: false, error: 'no-active-session-for-thread', retryable: false }
  }
  updateAgentSession({ dbPath, id: persisted.id, status: 'closed' })
  return { ok: true }
}
