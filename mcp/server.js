#!/usr/bin/env node
// MCP server, stdio transport, local profile — the full tool set (PLAN
// §6.3). Hand-rolled JSON-RPC over newline-delimited stdio rather than a
// dependency: the protocol surface needed here (initialize, tools/list,
// tools/call) is small and correctness of "nothing but protocol frames on
// stdout" is easiest to audit in code with no framework underneath it
// (§7's zero-dependency default — revisit if the remote/HTTP transport ever
// needs more of the spec than this covers).
//
// Hard rule: nothing may write to stdout except protocol frames. All
// logging goes to stderr — a stray console.log in a core function would
// corrupt the stream (§0, §6.3).

import { createInterface } from 'node:readline'
import { tools } from './tools.local.js'
import { loadContext } from '../cli/context.js'

const PROTOCOL_VERSION = '2024-11-05'
const context = loadContext()

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function respond(id, result) {
  if (id === undefined) return
  send({ jsonrpc: '2.0', id, result })
}

function respondError(id, code, message) {
  if (id === undefined) return
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(message) {
  const { id, method, params } = message

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'team-slack-bridge', version: '0.1.0' },
    })
    return
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return

  if (method === 'ping') {
    respond(id, {})
    return
  }

  if (method === 'tools/list') {
    respond(id, {
      tools: Object.values(tools).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    })
    return
  }

  if (method === 'tools/call') {
    const tool = tools[params?.name]
    if (!tool) {
      respondError(id, -32602, `unknown tool: ${params?.name}`)
      return
    }
    try {
      const result = await tool.handler(params?.arguments || {}, context)
      respond(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.ok })
    } catch (err) {
      respondError(id, -32000, err.message)
    }
    return
  }

  respondError(id, -32601, `method not found: ${method}`)
}

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', line => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch (err) {
    console.error(`invalid JSON-RPC frame on stdin: ${err.message}`)
    return
  }
  handle(message).catch(err => console.error(`unhandled error: ${err.message}`))
})

console.error('team-slack-bridge MCP server ready (profile: local, full tool set) on stdio')
