#!/usr/bin/env node
// Foreground process for the local MCP HTTP daemon (PLAN D22). Not meant to
// be run directly day-to-day — use `node cli/mcp-daemon.js start`, which
// spawns this detached and tracks it via listen/mcp-daemon.js's PID file.
//
// node cli/mcp-daemon-run.js
//
// Disabled unless slack-config.json has localMcpDaemon.enabled=true.
// TSB_MCP_DAEMON_PORT / TSB_MCP_DAEMON_ACCOUNT_MODE (set by `start`'s
// options) override slack-config.json's localMcpDaemon.port/accountMode.

import { createLocalMcpServer } from '../listen/mcp-http.js'
import { loadContext } from './context.js'

const { config } = loadContext()

if (!config.localMcpDaemon?.enabled) {
  console.error('localMcpDaemon.enabled is false in slack-config.json')
  process.exit(1)
}

const port = Number(process.env.TSB_MCP_DAEMON_PORT) || config.localMcpDaemon.port
const accountMode = process.env.TSB_MCP_DAEMON_ACCOUNT_MODE || config.localMcpDaemon.accountMode

const { listen } = createLocalMcpServer({ accountMode, port })

await listen()
console.error(`team-slack-bridge local MCP daemon on 127.0.0.1:${port} (accountMode: ${accountMode}, full local tool set)`)

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
