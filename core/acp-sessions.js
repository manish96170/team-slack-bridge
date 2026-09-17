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
import { writeHandoffFile } from './handoff.js'

const DEBOUNCE_MS = 1500
const MAX_RENDERED_CHARS = 2800
const DEFAULT_CONTEXT_WARNING_THRESHOLD = 0.8
const HANDOFF_SUMMARY_PROMPT =
  'Your context window is almost full. Summarize your progress so far and the concrete next steps as a concise handoff TODO for a fresh session to continue from, in plain markdown.'
const COMPACT_NUDGE_PROMPT =
  'Please summarize and trim down your working context now if possible, then continue. (Best-effort request — there is no protocol-level guarantee this reduces actual token usage.)'
const CONTEXT_FULL_SORRY_TEXT =
  "Sorry — I can't continue right now, I'm full on context. Reply *compact* to try trimming and continuing, *here* to start a fresh session in this thread seeded from the handoff, or *new thread* to start a separate one yourself."

const activeSessionsByKey = new Map()

// Matches the configured DM/mention trigger keyword(s) case-insensitively
// at the start of the text, returning the remainder (backend/repo/model
// flags + task) — or null if nothing matched. `mentionKeywords` (an array
// of aliases, e.g. "@etd start session") takes priority over the older
// single `mentionKeyword` string, sorted longest-first so a longer alias
// isn't shadowed by a shorter one that happens to be a prefix of it.
export function matchesMentionKeyword(text, config) {
  const lower = (text || '').toLowerCase()
  const configured = config.agentSessions?.mentionKeywords?.length
    ? config.agentSessions.mentionKeywords
    : [config.agentSessions?.mentionKeyword || 'start session']
  const keywords = configured.filter(Boolean).sort((a, b) => b.length - a.length)
  for (const keyword of keywords) {
    if (lower.startsWith(keyword.toLowerCase())) return (text || '').slice(keyword.length)
  }
  return null
}

export function contextUsageRatio(usage) {
  if (!usage || !usage.size) return 0
  return usage.used / usage.size
}

// Recognized only while a session is in the contextState:'full' gate below
// — outside that gate these are just ordinary words in a normal prompt.
export function parseContextFullCommand(text) {
  const t = (text || '').trim().toLowerCase()
  if (/^compact\b/.test(t)) return 'compact'
  if (/^here\b/.test(t) || /^new session\b/.test(t)) return 'here'
  if (/^new thread\b/.test(t)) return 'new-thread'
  return null
}

export function parseRewindCount(text) {
  const n = Number((text || '').trim())
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null
}

export function parseRewindDetail(text) {
  const t = (text || '').trim().toLowerCase()
  if (t.startsWith('summary and code') || t === 'code') return 'code'
  if (t.startsWith('just summary') || t === 'summary') return 'summary'
  return null
}

function sessionKey(channel, threadTs) {
  return `${channel}:${threadTs}`
}

// Two rapid-fire messages in the same thread (e.g. right after a listener
// restart, before the first reply finishes resuming) could both find no
// in-memory entry and race into tryResumeSession simultaneously — each
// registering its own updateQueue under the SAME acpSessionId and
// clobbering the other's. Found in review before publishing. This
// serializes anything keyed by the same {channel, threadTs} without
// blocking unrelated threads.
const keyLocks = new Map()

export function withKeyLock(key, fn) {
  const previous = keyLocks.get(key) || Promise.resolve()
  const next = previous.then(fn, fn)
  keyLocks.set(
    key,
    next.catch(() => {})
  )
  return next
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

// D31 — being allowed to START a session does NOT make you allowed to STOP
// someone else's. Only three people may close a given session: the owner
// (it's their machine), whoever actually started it, or someone the owner
// separately, explicitly listed in `agentSessions.allowedControllers` —
// a distinct grant from `allowedUsers`, since "can start their own
// sessions" and "can stop/manage other people's on the owner's behalf" are
// different levels of trust.
export function isAllowedToCloseSession(config, userId, startedBy) {
  if (!userId) return false
  if (config.owner?.slackUserId === userId) return true
  if (startedBy && userId === startedBy) return true
  return (config.agentSessions?.allowedControllers || []).includes(userId)
}

// `allowedUsers` only grants "may start/resume a session at all" — which
// registered repos they may point it at is a separate, optional grant via
// `agentSessions.repoAccess` ({ userId: [repoName, ...] }). A user with no
// repoAccess entry configured stays unrestricted, so installs that never
// set this up keep today's behavior; the owner is always unrestricted.
export function isAllowedToUseRepo(config, userId, repoName) {
  if (config.owner?.slackUserId === userId) return true
  const repoAccess = config.agentSessions?.repoAccess
  if (!repoAccess || !Object.prototype.hasOwnProperty.call(repoAccess, userId)) return true
  return (repoAccess[userId] || []).includes(repoName)
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
  if (!isAllowedToUseRepo(config, requestedBy, repoName)) {
    return { ok: false, error: 'no-active-session-for-thread', retryable: false }
  }

  // Anything here (spawn failure, resume/load rejection, a DB error) used
  // to propagate uncaught, all the way to Bolt's app.error handler — the
  // triggering thread reply would just vanish with zero feedback, never
  // even falling through to normal message handling. Same class of bug
  // found in startAgentSession; catch it and degrade the same way every
  // other resume failure already does.
  let connection, sessions, activeSession
  try {
    const backendConnection = await getBackendConnection(backend, env)
    connection = backendConnection.connection
    sessions = backendConnection.sessions
    const caps = backendConnection.initializeResponse?.agentCapabilities
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
    activeSession = createResumedSessionHandle({ connection, sessionId: acpSessionId, response, updateQueue })
  } catch {
    return { ok: false, error: 'no-active-session-for-thread', retryable: false }
  }

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

  const entry = {
    activeSession,
    backend,
    sessions,
    repoName,
    model,
    agentSessionRowId: persisted.id,
    startedBy: persisted.metadata?.requestedBy,
    progressTs: progressPost.ts,
    channel,
    threadTs,
    env,
    config,
    accumulatedText: '',
    transcript: [],
  }
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
  // usage_update (used/size, stable) is the real signal behind the
  // 80%-context warning below — no heuristic needed. compaction_update
  // only ever arrives if the client advertises ClientSessionCapabilities
  // .compaction (see core/acp-client.js's initialize call); when the agent
  // reports it finished one on its own, treat the context as no longer
  // full rather than waiting for the next usage_update to catch up.
  if (update.sessionUpdate === 'usage_update') {
    return { usage: { used: update.used, size: update.size } }
  }
  if (update.sessionUpdate === 'compaction_update' && update.status === 'completed') {
    return { text: '\n[context compacted]', compacted: true }
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
export async function runPromptTurn(entry, promptText) {
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

  // A rejected prompt() (connection error, auth failure, crashed backend)
  // must not just vanish — without this, nextUpdate() below waits forever
  // for a 'stop' message that will never arrive, and the Slack message
  // stays on "starting…" indefinitely. Confirmed this actually happens:
  // a Bedrock auth failure surfaced only as a listener-level console.error,
  // never reaching the user at all. failureSignal only ever resolves on
  // the error path — on success, the real 'stop' message still comes
  // through nextUpdate() as usual and this stays pending harmlessly.
  const failureSignal = new Promise(resolve => {
    entry.activeSession.prompt(promptText).then(
      () => {},
      err => resolve({ kind: 'error', error: err })
    )
  })

  for (;;) {
    const message = await Promise.race([entry.activeSession.nextUpdate(), failureSignal])
    if (message.kind === 'error') {
      if (flushTimer) clearTimeout(flushTimer)
      await finishProgress({
        token: entry.env.SLACK_BOT_TOKEN,
        channel: entry.channel,
        ts: entry.progressTs,
        label: sessionLabel(entry),
        detail: `${entry.accumulatedText.slice(-MAX_RENDERED_CHARS)}\n\n⚠️ ${message.error.message || message.error}`.trim(),
        ok: false,
        config: entry.config,
      })
      return { stopReason: 'error' }
    }
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
      entry.transcript = entry.transcript || []
      entry.transcript.push({ prompt: promptText, response: entry.accumulatedText, ts: Date.now() })
      if (entry.transcript.length > 20) entry.transcript = entry.transcript.slice(-20)
      await maybeWarnContextFull(entry)
      return message.response
    }
    const described = describeUpdate(message.notification.update)
    if (described) {
      if (described.text) {
        entry.accumulatedText += described.text
        scheduleFlush()
      }
      if (described.usage) entry.contextUsage = described.usage
      if (described.compacted) entry.contextState = 'normal'
    }
  }
}

// A no-frills sibling of the main streaming loop above, for prompts the
// bridge itself sends (the handoff self-summary, the rewind summary, the
// compact nudge's own re-check) rather than ones a Slack user typed —
// these must not recurse into maybeWarnContextFull or pollute the
// user-facing transcript/progress message, just return the plain text.
async function runInternalPrompt(entry, promptText) {
  let text = ''
  const failureSignal = new Promise(resolve => {
    entry.activeSession.prompt(promptText).then(
      () => {},
      err => resolve({ kind: 'error', error: err })
    )
  })
  for (;;) {
    const message = await Promise.race([entry.activeSession.nextUpdate(), failureSignal])
    if (message.kind === 'error' || message.kind === 'stop') return text
    const described = describeUpdate(message.notification.update)
    if (described?.text) text += described.text
    if (described?.usage) entry.contextUsage = described.usage
  }
}

// Fires once per crossing (never while already 'full') right after a turn
// finishes — never mid-stream, so it can't interleave with the turn's own
// finishProgress. Writes a self-summarized handoff file and gates further
// replies in this thread until the user picks compact/here/new-thread
// (routeThreadReply's contextState:'full' branch below).
async function maybeWarnContextFull(entry) {
  if (entry.contextState === 'full') return
  const threshold = entry.config?.agentSessions?.contextWarningThreshold ?? DEFAULT_CONTEXT_WARNING_THRESHOLD
  const ratio = contextUsageRatio(entry.contextUsage)
  if (ratio < threshold) return

  const summary = await runInternalPrompt(entry, HANDOFF_SUMMARY_PROMPT)
  const path = writeHandoffFile({ repoName: entry.repoName, summary })
  entry.contextState = 'full'
  entry.remindersSent = 0
  entry.handoffPath = path
  entry.handoffText = summary
  entry.lastWarningText = `⚠️ *Context is at ${Math.round(ratio * 100)}%* — this session is near its limit.\n\nHandoff summary written to \`${path}\`.\n\nReply *here* to continue in this thread with a fresh session seeded from this handoff, *new thread* to start a separate one yourself using that file, or *compact* to ask me to trim context and try continuing.`
  await startProgress({
    token: entry.env.SLACK_BOT_TOKEN,
    channel: entry.channel,
    label: sessionLabel(entry),
    detail: entry.lastWarningText,
    threadTs: entry.threadTs,
    config: entry.config,
  })
}

// Disposes the current ACP session and starts a brand-new one anchored to
// the SAME Slack thread, seeded with `seedTask` — the shared mechanism
// behind both "continue here" (handoff) and rewind-to-a-new-session.
// Deliberately calls startAgentSessionBody directly rather than the
// exported startAgentSession: the latter takes its own withKeyLock on this
// exact {channel, threadTs} key, and every caller of this function is
// already running inside that same lock (routeThreadReply's callback) —
// re-acquiring it here would deadlock forever waiting on itself.
async function startFreshSessionInPlace(entry, { env, config, dbPath, seedTask }) {
  const key = sessionKey(entry.channel, entry.threadTs)
  entry.activeSession.dispose()
  unregisterSession(entry.sessions, entry.activeSession.sessionId)
  activeSessionsByKey.delete(key)
  if (entry.agentSessionRowId) updateAgentSession({ dbPath, id: entry.agentSessionRowId, status: 'closed' })

  const backend = entry.backend
  const repo = resolveRepoPath(entry.repoName)
  if (!repo.ok) return repo
  const progressPost = await startProgress({
    token: env.SLACK_BOT_TOKEN,
    channel: entry.channel,
    label: `Agent session (${backend.name} · ${repo.name})`,
    detail: 'starting a fresh session…',
    threadTs: entry.threadTs,
    config,
  })
  if (!progressPost.ok) return progressPost
  return startAgentSessionBody({
    env,
    config,
    dbPath,
    channel: entry.channel,
    backend,
    repo,
    modelName: entry.model,
    task: seedTask,
    requestedBy: entry.startedBy,
    progressPost,
    anchorThreadTs: entry.threadTs,
  })
}

function buildHandoffSeedTask(handoffText) {
  return `Continuing from a previous session that reached its context limit. Handoff summary:\n\n${handoffText}\n\nPlease continue from here.`
}

function buildRewindSeedTask(seedText) {
  return `Continuing in a fresh session, rewound to an earlier point. Prior context:\n\n${seedText}\n\nPlease continue from here.`
}

// The contextState:'full' gate (see maybeWarnContextFull above): every
// reply in the thread lands here instead of running a normal turn, until
// the user picks one of the three options the warning offered.
async function handleContextFullReply({ entry, text, env, config, dbPath }) {
  const command = parseContextFullCommand(text)
  if (command === 'compact') {
    entry.contextState = 'normal'
    const progressPost = await startProgress({
      token: entry.env.SLACK_BOT_TOKEN,
      channel: entry.channel,
      label: sessionLabel(entry),
      detail: 'starting…',
      threadTs: entry.threadTs,
      config: entry.config,
    })
    if (!progressPost.ok) return progressPost
    entry.progressTs = progressPost.ts
    const response = await runPromptTurn(entry, COMPACT_NUDGE_PROMPT)
    return { ok: true, stopReason: response.stopReason }
  }
  if (command === 'here') {
    const started = await startFreshSessionInPlace(entry, { env, config, dbPath, seedTask: buildHandoffSeedTask(entry.handoffText) })
    return { ok: started.ok, stopReason: started.stopReason, error: started.error }
  }
  if (command === 'new-thread') {
    // Actually end it — the message below tells the user it's over, so the
    // DB row and in-memory entry need to agree, otherwise a listener
    // restart would happily resume it with the "full" gate forgotten
    // (contextState only ever lives in memory), contradicting what this
    // thread was just told.
    const key = sessionKey(entry.channel, entry.threadTs)
    entry.activeSession.dispose()
    unregisterSession(entry.sessions, entry.activeSession.sessionId)
    activeSessionsByKey.delete(key)
    if (entry.agentSessionRowId) updateAgentSession({ dbPath, id: entry.agentSessionRowId, status: 'closed' })
    await startProgress({
      token: entry.env.SLACK_BOT_TOKEN,
      channel: entry.channel,
      label: sessionLabel(entry),
      detail: `This session has ended due to context limits. Start a new session in a new thread — the handoff summary is at \`${entry.handoffPath}\` if you want to reference it.`,
      threadTs: entry.threadTs,
      config: entry.config,
    })
    return { ok: true }
  }
  // Not one of the three recognized commands — an organic reply. Resend
  // the warning exactly once (in case it was missed), then just refuse,
  // rather than silently spawning a real agent turn against a session
  // that's already over its context budget.
  const detail = entry.remindersSent ? CONTEXT_FULL_SORRY_TEXT : entry.lastWarningText
  entry.remindersSent = (entry.remindersSent || 0) + 1
  await startProgress({
    token: entry.env.SLACK_BOT_TOKEN,
    channel: entry.channel,
    label: sessionLabel(entry),
    detail,
    threadTs: entry.threadTs,
    config: entry.config,
  })
  return { ok: true }
}

// Rewind is a two-step free-text Q&A (how far back, then how much detail)
// tracked on entry.pendingRewind across separate Slack replies — approximated
// via a fresh new session seeded from OUR saved transcript, since ACP has no
// real rewind/checkpoint primitive to roll the live agent back to (confirmed:
// no session/rewind method, no checkpoint concept anywhere in the spec).
async function handleRewindStep({ entry, text, env, config, dbPath }) {
  const pending = entry.pendingRewind
  if (pending.step === 'count') {
    const count = parseRewindCount(text)
    if (!count) {
      await startProgress({
        token: entry.env.SLACK_BOT_TOKEN,
        channel: entry.channel,
        label: sessionLabel(entry),
        detail: 'Please reply with a number from 1 to 10.',
        threadTs: entry.threadTs,
        config: entry.config,
      })
      return { ok: true }
    }
    entry.pendingRewind = { step: 'detail', count }
    await startProgress({
      token: entry.env.SLACK_BOT_TOKEN,
      channel: entry.channel,
      label: sessionLabel(entry),
      detail: 'Summary and code, or just summary?',
      threadTs: entry.threadTs,
      config: entry.config,
    })
    return { ok: true }
  }

  const detail = parseRewindDetail(text)
  if (!detail) {
    await startProgress({
      token: entry.env.SLACK_BOT_TOKEN,
      channel: entry.channel,
      label: sessionLabel(entry),
      detail: 'Please reply "summary and code" or "just summary".',
      threadTs: entry.threadTs,
      config: entry.config,
    })
    return { ok: true }
  }

  const count = pending.count
  entry.pendingRewind = null
  const excerptTurns = (entry.transcript || []).slice(-count)
  // The transcript only ever lives in memory (never persisted across a
  // restart) — a just-resumed entry has none, so rewinding it would
  // silently start a brand-new, context-free session while claiming to
  // continue from "an earlier point." Refuse instead of faking it.
  if (excerptTurns.length === 0) {
    await startProgress({
      token: entry.env.SLACK_BOT_TOKEN,
      channel: entry.channel,
      label: sessionLabel(entry),
      detail: "This session has no saved transcript to rewind (e.g. it was just resumed after a restart) — nothing to rewind to.",
      threadTs: entry.threadTs,
      config: entry.config,
    })
    return { ok: true }
  }
  const seedText =
    detail === 'code'
      ? excerptTurns.map(t => `> ${t.prompt}\n\n${t.response}`).join('\n\n---\n\n')
      : await runInternalPrompt(entry, `In plain prose with no code, summarize the last ${count} exchanges of this session.`)
  const started = await startFreshSessionInPlace(entry, { env, config, dbPath, seedTask: buildRewindSeedTask(seedText) })
  return { ok: started.ok, stopReason: started.stopReason, error: started.error }
}

export async function startAgentSession({ env, config, dbPath, channel, threadTs, backendName, repoName, modelName, task, requestedBy }) {
  if (!isAllowedToStartSession(config, requestedBy)) {
    return { ok: false, error: 'not-allowed-to-start-agent-session', retryable: false }
  }
  const backend = getBackend(backendName)
  if (!backend) return { ok: false, error: 'unknown-backend', retryable: false }

  const repo = resolveRepoPath(repoName)
  if (!repo.ok) return repo
  if (!isAllowedToUseRepo(config, requestedBy, repo.name)) {
    return { ok: false, error: 'not-allowed-to-use-repo', retryable: false }
  }

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

  // Same lock routeThreadReply uses, keyed the same way — without this, a
  // reply arriving while THIS initial prompt is still in flight (e.g. the
  // task needs a permission approval, so the first runPromptTurn call below
  // is still awaiting it) would find the entry already in
  // activeSessionsByKey and call runPromptTurn on it a second time
  // concurrently, both mutating entry.accumulatedText and racing on the
  // same Slack message. Found in review before publishing.
  return withKeyLock(sessionKey(channel, anchorThreadTs), () => startAgentSessionBody({ env, config, dbPath, channel, threadTs, backend, repo, modelName, task, requestedBy, progressPost, anchorThreadTs }))
}

async function startAgentSessionBody({ env, config, dbPath, channel, backend, repo, modelName, task, requestedBy, progressPost, anchorThreadTs }) {
  // Everything from here through runPromptTurn's own setup can throw
  // (spawn failure, initialize/session-new rejection, a DB error) — found
  // in review before publishing that NONE of it was caught. The consequence
  // is exactly what happened live: the "starting…" message stays stuck
  // forever, and the only trace is a console.error nobody using Slack ever
  // sees. Anything past this point that fails now updates the Slack
  // message with the real error instead of hanging silently.
  try {
    const { connection, sessions } = await getBackendConnection(backend, env)
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
      // acpSessionId is what makes resume-after-restart (Phase 4) possible
      // — without it, a restarted listener has no way to reconnect this
      // thread to the agent's own persisted conversation state.
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
      startedBy: requestedBy,
      progressTs: progressPost.ts,
      channel,
      threadTs: anchorThreadTs,
      env,
      config,
      accumulatedText: '',
      transcript: [],
    }
    activeSessionsByKey.set(sessionKey(channel, anchorThreadTs), entry)

    const response = await runPromptTurn(entry, task)
    return { ok: true, sessionId: activeSession.sessionId, channel, threadTs: anchorThreadTs, stopReason: response.stopReason }
  } catch (err) {
    await finishProgress({
      token: env.SLACK_BOT_TOKEN,
      channel,
      ts: progressPost.ts,
      label: `Agent session (${backend.name} · ${repo.name})`,
      detail: `⚠️ ${err.message || err}`,
      ok: false,
      config,
    })
    return { ok: false, error: 'agent-session-start-failed', message: err.message, retryable: false }
  }
}

// Callers (listen/socket.js) call this unconditionally for every thread
// reply — it's a cheap indexed DB lookup in the common case where a thread
// never had a session, and falls through to normal message handling
// exactly as before whenever it returns ok:false, whether that's "never had
// a session" or "had one but it's unresumable now".
export async function routeThreadReply({ env, config, dbPath, channel, threadTs, text, requestedBy }) {
  const key = sessionKey(channel, threadTs)
  return withKeyLock(key, async () => {
    let entry = activeSessionsByKey.get(key)
    if (!entry) {
      const resumed = await tryResumeSession({ env, config, dbPath, channel, threadTs, requestedBy })
      if (!resumed.ok) return resumed
      entry = resumed.entry
      const response = await runPromptTurn(entry, text)
      return { ok: true, stopReason: response.stopReason }
    }

    if (entry.pendingRewind) return handleRewindStep({ entry, text, env, config, dbPath })
    if (/^rewind\b/i.test((text || '').trim())) {
      entry.pendingRewind = { step: 'count' }
      await startProgress({
        token: entry.env.SLACK_BOT_TOKEN,
        channel: entry.channel,
        label: sessionLabel(entry),
        detail: 'How many exchanges back do you want to rewind to? Reply with a number from 1 to 10.',
        threadTs: entry.threadTs,
        config: entry.config,
      })
      return { ok: true }
    }
    if (entry.contextState === 'full') return handleContextFullReply({ entry, text, env, config, dbPath })

    // Post a fresh message for this turn instead of reusing the
    // progressTs captured at session creation — without this, every
    // reply in the thread just edits that first "starting…" message
    // in place rather than appearing as its own reply.
    const progressPost = await startProgress({
      token: entry.env.SLACK_BOT_TOKEN,
      channel: entry.channel,
      label: sessionLabel(entry),
      detail: 'starting…',
      threadTs,
      config: entry.config,
    })
    if (!progressPost.ok) return progressPost
    entry.progressTs = progressPost.ts
    const response = await runPromptTurn(entry, text)
    return { ok: true, stopReason: response.stopReason }
  })
}

// Closing doesn't need to reconnect to the backend at all — it's pure local
// bookkeeping (drop the in-memory entry if any, mark the DB row closed) —
// so this also works for a session lost to a restart and never resumed,
// not just a currently-live one. Without the DB fallback, "close" on a
// not-yet-resumed session would fail even though the whole point is to
// make sure it never gets resumed later.
// Gated the same way as starting one (D24) — anyone in the channel could
// otherwise stop or close a session they didn't start.
// Locked on the same {channel, threadTs} key as routeThreadReply/
// startAgentSession — without this, "stop" typed at the same moment as a
// context-full "here"/rewind fresh-session replacement (both of which hold
// this lock while they dispose the old session and register a new one)
// could interleave: this function's own body has no awaits so it can't be
// interrupted mid-way, but the ORDERING between it and those multi-await
// flows was otherwise unguarded, letting a "stop" get silently undone by a
// fresh session that started concurrently and re-registered the key.
export async function closeAgentSession({ dbPath, config, channel, threadTs, requestedBy }) {
  const key = sessionKey(channel, threadTs)
  return withKeyLock(key, async () => {
    const entry = activeSessionsByKey.get(key)
    if (entry) {
      if (!isAllowedToCloseSession(config, requestedBy, entry.startedBy)) {
        return { ok: false, error: 'not-allowed-to-close-agent-session', retryable: false }
      }
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
    if (!isAllowedToCloseSession(config, requestedBy, persisted.metadata?.requestedBy)) {
      return { ok: false, error: 'not-allowed-to-close-agent-session', retryable: false }
    }
    updateAgentSession({ dbPath, id: persisted.id, status: 'closed' })
    return { ok: true }
  })
}
