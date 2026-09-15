// Local-trust MCP HTTP daemon (PLAN D22) — lets multiple AI coding harnesses
// (Claude Code, Codex, others) share one running server instead of each
// spawning their own stdio mcp/server.js subprocess. Deliberately separate
// from mcp/http.js (the locked-down, Slack-signature-gated, 9-tool remote
// profile per D5/D20) — this exposes the FULL local tool set, because
// anything that can reach this server already has filesystem/env access to
// the same secrets. Hardcoded to bind 127.0.0.1 only; never configurable to
// 0.0.0.0, by the same "absent by omission" principle as D5.

import http from 'node:http'
import { tools } from '../mcp/tools.local.js'
import { validateArguments } from '../mcp/validation.js'
import { withAccountField } from '../mcp/schema.js'
import { loadAccountContext, listAccounts } from '../core/accounts.js'

const PROTOCOL_VERSION = '2024-11-05'
const BIND_HOST = '127.0.0.1'

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function respond(id, result) {
  return id === undefined ? null : { jsonrpc: '2.0', id, result }
}

function respondError(id, code, message) {
  return id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } }
}

// One loaded context per account name for the life of the daemon — same
// load-once-at-startup behavior mcp/server.js already has for the
// single-account stdio server, just keyed by account instead of global.
function createContextCache() {
  const cache = new Map()
  return name => {
    const key = name || ''
    if (!cache.has(key)) cache.set(key, loadAccountContext(name))
    return cache.get(key)
  }
}

export function createLocalMcpServer({ accountMode = 'single', port = 8918 } = {}) {
  const getContext = createContextCache()
  const defaultAccount = listAccounts().default

  async function handleMessage(message) {
    const { id, method, params } = message || {}

    if (method === 'initialize') {
      return respond(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'team-slack-bridge-local-daemon', version: '0.1.0' } })
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null
    if (method === 'ping') return respond(id, {})

    if (method === 'tools/list') {
      return respond(id, {
        tools: Object.values(tools).map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: accountMode === 'multi' ? withAccountField(tool.inputSchema) : tool.inputSchema,
        })),
      })
    }

    if (method === 'tools/call') {
      const tool = tools[params?.name]
      if (!tool) return respondError(id, -32602, `unknown tool: ${params?.name}`)

      const { account, ...args } = params?.arguments || {}
      if (accountMode !== 'multi' && account && account !== defaultAccount) {
        return respondError(id, -32602, `this daemon is running in single-account mode (account: ${defaultAccount}) — account "${account}" was requested`)
      }
      const inputSchema = accountMode === 'multi' ? withAccountField(tool.inputSchema) : tool.inputSchema
      const validationError = validateArguments(inputSchema, params?.arguments || {})
      if (validationError) return respondError(id, -32602, validationError)

      const context = getContext(accountMode === 'multi' ? account : undefined)
      if (!context.ok) return respond(id, { content: [{ type: 'text', text: JSON.stringify(context) }], isError: true })

      try {
        const result = await tool.handler(args, context)
        return respond(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.ok })
      } catch (err) {
        return respondError(id, -32000, err.message)
      }
    }

    return respondError(id, -32601, `method not found: ${method}`)
  }

  async function requestHandler(req, res) {
    if (req.method === 'GET' && req.url === '/mcp') {
      sendJson(res, 200, { ok: true, accountMode, defaultAccount })
      return
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      sendJson(res, 404, { ok: false, error: 'not-found' })
      return
    }
    try {
      const body = await readBody(req)
      const message = JSON.parse(body)
      if (Array.isArray(message)) {
        const responses = []
        for (const item of message) {
          const response = await handleMessage(item)
          if (response) responses.push(response)
        }
        sendJson(res, responses.length ? 200 : 202, responses)
        return
      }
      const response = await handleMessage(message)
      sendJson(res, response ? 200 : 202, response || { ok: true })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message })
    }
  }

  const server = http.createServer(requestHandler)
  return {
    server,
    handleMessage,
    listen: () => new Promise(resolve => server.listen(port, BIND_HOST, resolve)),
    close: () => new Promise(resolve => server.close(resolve)),
  }
}
