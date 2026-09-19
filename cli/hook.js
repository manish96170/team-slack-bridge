#!/usr/bin/env node
// tsb-hook preToolUse|stop|preCompact|notification
//
// Claude Code hook dispatcher. Reads hook input from stdin (JSON),
// calls the handler in core/hooks.js, writes the hook output to stdout.
//
// Safety contract: any internal error prints nothing and exits 0, so a
// bug in this file can never wedge the user's session. The only path
// that exits non-zero is `stop` when blocking (exit 2 + reason on
// stderr), per the verified harness contract.

import { loadContext } from './context.js'
import { preToolUse, preCompact, stop, notification } from '../core/hooks.js'

const HANDLERS = { preToolUse, preCompact, stop, notification }

async function main() {
  const [event] = process.argv.slice(2)
  const handler = HANDLERS[event]
  if (!handler) {
    process.exit(0)
  }

  let input = {}
  try {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (raw) input = JSON.parse(raw)
  } catch {
    // Malformed or missing stdin — proceed with empty input, handler
    // will skip or fail open as appropriate.
  }

  const { env, config, dbPath } = loadContext()
  const result = await handler(input, { env, config, dbPath })

  if (result.skip) {
    process.exit(0)
  }

  if (event === 'stop') {
    if (result.block) {
      process.stderr.write(result.reason || 'Continue with instruction from Slack')
      process.exit(2)
    }
    // allow — just exit 0
    process.exit(0)
  }

  if (event === 'preToolUse') {
    const output = {
      hookSpecificOutput: {
        permissionDecision: result.decision || 'ignore',
        ...(result.reason ? { permissionDecisionReason: result.reason } : {}),
      },
    }
    process.stdout.write(JSON.stringify(output))
    process.exit(0)
  }

  if (event === 'preCompact') {
    const output = {
      hookSpecificOutput: {
        compactionDecision: result.decision || 'allow',
      },
    }
    process.stdout.write(JSON.stringify(output))
    process.exit(0)
  }

  // notification — no output needed
  process.exit(0)
}

main().catch(() => {
  // Safety net — any uncaught error must never wedge the session.
  process.exit(0)
})
