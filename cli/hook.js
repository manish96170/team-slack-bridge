#!/usr/bin/env node
// tsb-hook preToolUse|stop|preCompact|notification
//
// Claude Code hook adapter. Reads hook input from stdin (JSON), calls the
// harness-neutral handlers in core/hooks.js with harness='claude', and
// translates neutral verdicts into Claude Code's hook output format.
//
// Safety contract: any internal error prints nothing and exits 0, so a
// bug in this file can never wedge the user's session. The only path
// that exits non-zero is stop→block (exit 2 + reason on stderr).
//
// Hook output schema (verified against Claude Code docs):
// - hookEventName is REQUIRED in hookSpecificOutput for all events
// - PreToolUse: permissionDecision = "allow" | "deny" | "block"
// - PreCompact: observational only, no blocking mechanism
// - Stop: exit 2 blocks the stop and continues; exit 0 allows it

import { loadContext } from './context.js'
import { preToolUse, preCompact, stop, notification } from '../core/hooks.js'

const HANDLERS = { preToolUse, preCompact, stop, notification }

async function main() {
  const [event] = process.argv.slice(2)
  const handler = HANDLERS[event]
  if (!handler) process.exit(0)

  let input = {}
  let stdinValid = false
  try {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (raw) {
      input = JSON.parse(raw)
      stdinValid = true
    }
  } catch {}

  if (!stdinValid && event === 'stop') process.exit(0)

  const { env, config, dbPath } = loadContext()
  const result = await handler(input, { env, config, dbPath, harness: 'claude' })

  if (result.verdict === 'skip' || result.verdict === 'ok') {
    process.exit(0)
  }

  if (event === 'preToolUse') {
    if (result.verdict === 'allow' || result.verdict === 'deny') {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: result.verdict,
          ...(result.reason ? { permissionDecisionReason: result.reason } : {}),
        },
      }))
    }
    // verdict='defer' → no JSON, exit 0 (Claude falls through to local prompt)
    process.exit(0)
  }

  if (event === 'stop') {
    if (result.verdict === 'block') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop' } }))
      const reason = result.reason || 'Continue with instruction from Slack'
      await new Promise(resolve => process.stderr.write(reason, resolve))
      process.exit(2)
    }
    process.exit(0)
  }

  // preCompact, notification — observational, just exit
  process.exit(0)
}

main().catch(() => process.exit(0))
