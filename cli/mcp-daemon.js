#!/usr/bin/env node
// node cli/mcp-daemon.js start|stop|restart|status|logs [--port 8918] [--account-mode single|multi] [--lines 80] [--json]
//
// Controls the local MCP HTTP daemon (listen/mcp-http.js, PLAN D22) — lets
// multiple AI coding harnesses share one running server on 127.0.0.1
// instead of each spawning their own stdio mcp/server.js subprocess.

import { logs, restart, start, status, stop } from '../listen/mcp-daemon.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const [command] = process.argv.slice(2)
const flags = parseFlags(process.argv.slice(3), ['json'])

let result
if (command === 'start' || command === 'restart') {
  const { config } = loadContext()
  if (!config.localMcpDaemon?.enabled) {
    result = { ok: false, error: 'local-mcp-daemon-disabled-in-config', retryable: false }
  } else {
    const opts = {
      port: flags.port ? Number(flags.port) : config.localMcpDaemon.port,
      accountMode: flags['account-mode'] || config.localMcpDaemon.accountMode,
    }
    result = command === 'start' ? start(opts) : restart(opts)
  }
} else if (command === 'stop') {
  result = stop()
} else if (command === 'status') {
  result = status()
} else if (command === 'logs') {
  result = logs({ lines: flags.lines ? Number(flags.lines) : undefined })
  if (!flags.json) {
    console.log(result.text)
    process.exit(0)
  }
} else {
  console.error('usage: mcp-daemon.js <start|stop|restart|status|logs> [--port <n>] [--account-mode single|multi] [--lines <n>] [--json]')
  process.exit(1)
}

output(result, { json: flags.json })
