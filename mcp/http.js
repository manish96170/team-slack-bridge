import { tools as remoteTools } from './tools.remote.js'
import { validateArguments } from './validation.js'
import { findRemoteOwnedByTs, getEntry } from '../core/ledger.js'
import { recordRemoteAudit, reserveRemoteCall, updateRemoteAudit } from '../core/remote-audit.js'
import { normalizeSlackbotMcp } from '../core/slackbot-mcp.js'

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_SLACKBOT_TOOLS = new Set(['slack_doctor'])
const AUTHENTICATED_REMOTE_AUTH_TYPES = new Set(['slack_identity_auth'])
const WRITE_TOOLS = new Set([
  'slack_post',
  'slack_reply',
  'slack_react',
  'slack_update_message',
  'slack_delete_message',
])
const CHANNEL_WRITE_TOOLS = new Set([
  'slack_post',
  'slack_reply',
  'slack_react',
  'slack_update_message',
  'slack_delete_message',
  'slack_schedule_message',
  'slack_delete_scheduled_message',
  'slack_progress_start',
  'slack_progress_update',
  'slack_progress_finish',
])
const CHANNEL_READ_TOOLS = new Set(['slack_query_messages', 'slack_get_thread'])
const LEDGER_CREATING_TOOLS = new Set(['slack_post', 'slack_reply'])
const OWNED_MESSAGE_TOOLS = new Set(['slack_update_message', 'slack_delete_message'])

export function getSlackbotMcpTools(config) {
  const settings = normalizeSlackbotMcp(config?.slackbotMcp)
  const requested = settings.allowedTools?.length ? new Set(settings.allowedTools) : DEFAULT_SLACKBOT_TOOLS
  const result = {}

  for (const name of requested) {
    if (settings.authType !== 'slack_identity_auth' && name !== 'slack_doctor') continue
    if (!settings.exposeWriteTools && WRITE_TOOLS.has(name)) continue
    const tool = remoteTools[name]
    if (tool) result[name] = tool
  }

  return result
}

function success(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function configuredChannels(list = []) {
  return new Set(list.filter(Boolean))
}

function slackPrincipal(params) {
  const slack = params?._meta?.slack
  if (!slack?.user_id) return null
  if (!('team_id' in slack) || !('enterprise_id' in slack)) return null
  return slack
}

export function authorizeRemoteToolCall({ name, args, config, dbPath, principal }) {
  const settings = normalizeSlackbotMcp(config?.slackbotMcp)
  if (name !== 'slack_doctor') {
    if (!AUTHENTICATED_REMOTE_AUTH_TYPES.has(settings.authType)) {
      return { ok: false, error: 'remote-mcp-requires-slack-identity-auth', retryable: false }
    }
    if (!principal) return { ok: false, error: 'remote-mcp-slack-identity-required', retryable: false }
    if (!dbPath) return { ok: false, error: 'remote-mcp-db-required', retryable: false }
  }
  if (CHANNEL_WRITE_TOOLS.has(name)) {
    const allowed = configuredChannels(config.remote?.postableChannels)
    if (!allowed.has(args.channel)) return { ok: false, error: 'channel-not-remote-postable', retryable: false }
  }
  if (CHANNEL_READ_TOOLS.has(name)) {
    const allowed = configuredChannels(config.remote?.readableChannels)
    if (!allowed.has(args.channel)) return { ok: false, error: 'channel-not-remote-readable', retryable: false }
  }
  if (LEDGER_CREATING_TOOLS.has(name) && !args.idempotencyKey) {
    return { ok: false, error: 'remote-mcp-idempotency-key-required', retryable: false }
  }
  if (LEDGER_CREATING_TOOLS.has(name) && args.idempotencyKey) {
    const existing = getEntry(dbPath, args.idempotencyKey)
    if (existing?.status === 'pending') return { ok: false, error: 'remote-mcp-idempotency-key-already-in-flight', retryable: false }
    if (existing?.status === 'done' && (!existing.result?.remote || existing.result.principal !== principal.user_id)) {
      return { ok: false, error: 'remote-mcp-idempotency-key-owned-by-different-principal', retryable: false }
    }
  }
  if (OWNED_MESSAGE_TOOLS.has(name) && !findRemoteOwnedByTs(dbPath, args.channel, args.ts, principal?.user_id)) {
    return { ok: false, error: 'remote-mcp-not-own-message', retryable: false }
  }
  return { ok: true }
}

export async function handleMcpMessage({ message, env, config, dbPath }) {
  const { id, method, params } = message || {}

  if (method === 'initialize') {
    return success(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'team-slack-bridge-slackbot', version: '0.1.0' },
    })
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null
  if (method === 'ping') return success(id, {})

  if (method === 'tools/list') {
    const tools = getSlackbotMcpTools(config)
    return success(id, {
      tools: Object.values(tools).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    })
  }

  if (method === 'tools/call') {
    const tools = getSlackbotMcpTools(config)
    const tool = tools[params?.name]
    if (!tool) return error(id, -32602, `remote profile unknown or disabled tool: ${params?.name}`)

    const args = params?.arguments || {}
    const validationError = validateArguments(tool.inputSchema, args)
    if (validationError) return error(id, -32602, validationError)

    const principal = slackPrincipal(params)
    try {
      const authorized = authorizeRemoteToolCall({ name: params.name, args, config, dbPath, principal })
      if (!authorized.ok) {
        recordRemoteAudit({ dbPath, principal, tool: params.name, ok: false, error: authorized.error, channel: args.channel, ts: args.ts })
        return success(id, { content: [{ type: 'text', text: JSON.stringify(authorized) }], isError: true })
      }
      const reservation = params.name === 'slack_doctor'
        ? { ok: true }
        : reserveRemoteCall({ dbPath, principal, tool: params.name, rateLimitPerMinute: normalizeSlackbotMcp(config?.slackbotMcp).rateLimitPerMinute, channel: args.channel, ts: args.ts })
      if (!reservation.ok) {
        recordRemoteAudit({ dbPath, principal, tool: params.name, ok: false, error: reservation.error, channel: args.channel, ts: args.ts })
        return success(id, { content: [{ type: 'text', text: JSON.stringify(reservation) }], isError: true })
      }
      const result = await tool.handler(args, { env, config, dbPath, slack: principal })
      if (reservation.auditId) {
        updateRemoteAudit({ dbPath, auditId: reservation.auditId, ok: result.ok, error: result.error, channel: args.channel || result.channel, ts: args.ts || result.ts })
      } else {
        recordRemoteAudit({ dbPath, principal, tool: params.name, ok: result.ok, error: result.error, channel: args.channel || result.channel, ts: args.ts || result.ts })
      }
      return success(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.ok })
    } catch (err) {
      recordRemoteAudit({ dbPath, principal, tool: params.name, ok: false, error: err.message, channel: args.channel, ts: args.ts })
      return error(id, -32000, err.message)
    }
  }

  return error(id, -32601, `method not found: ${method}`)
}
