// Config loading and handle resolution (PLAN §4.4). No hardcoded handles —
// identity mapping is per-install config, never baked into code.

import { readFileSync, existsSync } from 'node:fs'
import { normalizeSlackbotMcp } from './slackbot-mcp.js'

const resolutionCache = new WeakMap()

export function loadConfig(path) {
  if (!existsSync(path)) {
    return {
      users: [],
      watchedChannels: [],
      owner: {},
      dmAllowlist: [],
      outputMode: 'medium',
      http: { enabled: false, port: 8917, verifySlackSignatures: true },
      slashCommands: { enabled: false, outputModeCommand: '/outputmode' },
      agentSessions: {
        enabled: false,
        autoCreateSession: false,
        provider: 'none',
        allowedUsers: [],
        mentionKeyword: 'start session',
        mentionKeywords: [],
        allowedControllers: [],
        repoAccess: {},
        trustedApps: {},
        contextWarningThreshold: 0.8,
      },
      awayMode: {
        gatedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit'],
        hookTimeoutSeconds: 300,
        maxContinuations: 3,
      },
      openacp: { enabled: false, adapterPackage: '@openacp/slack-adapter', autoCreateSession: false },
      slackbotMcp: normalizeSlackbotMcp(),
      remote: { postableChannels: [], readableChannels: [] },
      localMcpDaemon: { enabled: false, port: 8918, accountMode: 'single' },
    }
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  return {
    users: raw.users || [],
    watchedChannels: raw.watchedChannels || [],
    owner: raw.owner || {},
    dmAllowlist: raw.dmAllowlist || [],
    outputMode: ['low', 'medium', 'high'].includes(raw.outputMode) ? raw.outputMode : 'medium',
    http: {
      enabled: !!raw.http?.enabled,
      port: raw.http?.port || 8917,
      verifySlackSignatures: raw.http?.verifySlackSignatures !== false,
    },
    slashCommands: {
      enabled: !!raw.slashCommands?.enabled,
      outputModeCommand: raw.slashCommands?.outputModeCommand || '/outputmode',
    },
    agentSessions: {
      enabled: !!raw.agentSessions?.enabled,
      autoCreateSession: !!raw.agentSessions?.autoCreateSession,
      provider: raw.agentSessions?.provider || 'none',
      // D24 — who may start an ACP agent session (any trigger). Owner is
      // always allowed on top of this list; never gated by channel
      // membership alone, since a session can run real shell commands.
      allowedUsers: raw.agentSessions?.allowedUsers || [],
      // Phase 2 trigger — an @mention whose text starts with this phrase
      // (case-insensitive) starts a session instead of a normal classified
      // proposal. Empty string disables the mention trigger entirely.
      mentionKeyword: raw.agentSessions?.mentionKeyword ?? 'start session',
      // Alternate trigger phrases (e.g. "@etd start session") that work
      // the same as mentionKeyword, in both @mentions and DMs — checked by
      // matchesMentionKeyword (core/acp-sessions.js), longest-first.
      mentionKeywords: raw.agentSessions?.mentionKeywords || [],
      // D31 — a SEPARATE grant from allowedUsers: being allowed to start
      // your own sessions doesn't make you allowed to stop someone else's.
      // Only the owner, a session's own starter, or someone explicitly
      // listed here may close/stop a session that isn't their own.
      allowedControllers: raw.agentSessions?.allowedControllers || [],
      // A SEPARATE, optional grant from allowedUsers: which named repos
      // (core/repos.js) a given user may point a session at. Omitted for a
      // user (or entirely) means unrestricted — see isAllowedToUseRepo.
      repoAccess: raw.agentSessions?.repoAccess || {},
      // Lets a specific Slack app (bot_id or app_id) DM-trigger sessions on
      // a named human's behalf — see matchesMentionKeyword's caller in
      // listen/socket.js and isAllowedToStartSession's normal checks, which
      // still apply to whichever human the app is mapped to act as.
      trustedApps: raw.agentSessions?.trustedApps || {},
      // Fraction of the ACP-reported context window (usage_update's
      // used/size) at which the bridge triggers the handoff-file warning —
      // see maybeWarnContextFull in core/acp-sessions.js.
      contextWarningThreshold: raw.agentSessions?.contextWarningThreshold ?? 0.8,
    },
    // D39/D40 — away-mode policy lives in the bridge, not harness config.
    // hookTimeoutSeconds was previously read as config.hookTimeoutSeconds
    // (core/hooks.js:75, :171) but never listed here, so it was permanently
    // undefined and the || 300 fallback always won — now surfaced properly.
    awayMode: {
      gatedTools: raw.awayMode?.gatedTools || ['Bash', 'Edit', 'Write', 'NotebookEdit'],
      hookTimeoutSeconds: raw.awayMode?.hookTimeoutSeconds ?? 300,
      maxContinuations: raw.awayMode?.maxContinuations ?? 3,
    },
    openacp: {
      enabled: !!raw.openacp?.enabled,
      adapterPackage: raw.openacp?.adapterPackage || '@openacp/slack-adapter',
      autoCreateSession: !!raw.openacp?.autoCreateSession,
    },
    slackbotMcp: normalizeSlackbotMcp(raw.slackbotMcp),
    remote: {
      postableChannels: raw.remote?.postableChannels || [],
      readableChannels: raw.remote?.readableChannels || [],
    },
    localMcpDaemon: {
      enabled: !!raw.localMcpDaemon?.enabled,
      port: raw.localMcpDaemon?.port || 8918,
      accountMode: raw.localMcpDaemon?.accountMode === 'multi' ? 'multi' : 'single',
    },
  }
}

function matchesUser(user, handleOrName) {
  const needle = handleOrName.toLowerCase().replace(/^@/, '')
  return (
    user.name?.toLowerCase() === needle ||
    user.slackHandle?.toLowerCase().replace(/^@/, '') === needle ||
    user.slackUserId === handleOrName
  )
}

// `configuredOnly` is the remote-profile limit (§11.6 #4): only handles
// present in slack-config.json's `users` list resolve on remote. Local
// carries the same restriction today — live directory lookup via
// `users.list` is a documented follow-on, not built yet.
export function resolveUser(handleOrName, config) {
  if (!handleOrName) return { ok: false, error: 'handle-required', retryable: false }
  if (!config) return { ok: false, error: 'user-not-configured', retryable: false }
  let cache = resolutionCache.get(config)
  if (!cache) {
    cache = new Map()
    resolutionCache.set(config, cache)
  }
  const cacheKey = handleOrName.toLowerCase()
  if (cache.has(cacheKey)) return cache.get(cacheKey)

  const found = (config.users || []).find(user => matchesUser(user, handleOrName))
  if (!found) {
    const result = { ok: false, error: 'user-not-configured', retryable: false }
    cache.set(cacheKey, result)
    return result
  }
  const result = { ok: true, userId: found.slackUserId, name: found.name }
  cache.set(cacheKey, result)
  return result
}

// Turns literal "@handle" text into a real Slack mention (`<@USERID>`) —
// added 2026-09-09 because a plain "@PJ" in posted text is never rendered
// as a tag by Slack; only the `<@USERID>` syntax is. Only handles present
// in slack-config.json's `users` list resolve — an unmatched "@word" is
// left exactly as typed rather than guessed at or stripped, since a wrong
// substitution (tagging the wrong person) is worse than no substitution.
const MENTION_PATTERN = /@([A-Za-z0-9_.-]+)/g

export function resolveMentions(text, config) {
  if (!text || !config) return text
  return text.replace(MENTION_PATTERN, (match, handle) => {
    const resolved = resolveUser(`@${handle}`, config)
    return resolved.ok ? `<@${resolved.userId}>` : match
  })
}
