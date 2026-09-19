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
//
// Hook output schema (verified against Claude Code docs):
// - hookEventName is REQUIRED in hookSpecificOutput for all events
// - PreToolUse: permissionDecision = "allow" | "deny" | "block"
//   ("ignore" is NOT valid — for fail-open, emit no JSON and exit 0)
// - PreCompact: observational only, no blocking mechanism exists
//   (exit 2 does NOT prevent compaction either)
// - Stop: exit 2 blocks the stop and continues; exit 0 allows it

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
  let stdinValid = false
  try {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (raw) {
      input = JSON.parse(raw)
      stdinValid = true
    }
  } catch {
    // Malformed stdin — fail open rather than acting on garbage.
  }
  // A stop hook with missing/malformed input must never block the session.
  if (!stdinValid && event === 'stop') {
    process.exit(0)
  }

  const { env, config, dbPath } = loadContext()
  const result = await handler(input, { env, config, dbPath })

  if (result.skip) {
    process.exit(0)
  }

  if (event === 'preToolUse') {
    if (result.decision === 'allow' || result.decision === 'deny') {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: result.decision,
          ...(result.reason ? { permissionDecisionReason: result.reason } : {}),
        },
      }
      process.stdout.write(JSON.stringify(output))
    }
    // For fail-open (ignore/timeout/error): emit no JSON, just exit 0 —
    // "ignore" is not a valid permissionDecision value, and exiting 0 with
    // no output means the harness falls through to the normal local prompt.
    process.exit(0)
  }

  if (event === 'stop') {
    if (result.block) {
      // Write the JSON output first (hookEventName required), then the
      // reason to stderr, then exit 2. Use an explicit drain to avoid
      // truncation when stderr is a pipe.
      const output = { hookSpecificOutput: { hookEventName: 'Stop' } }
      process.stdout.write(JSON.stringify(output))
      const reason = result.reason || 'Continue with instruction from Slack'
      await new Promise(resolve => process.stderr.write(reason, resolve))
      process.exit(2)
    }
    // allow — just exit 0
    process.exit(0)
  }

  if (event === 'preCompact') {
    // PreCompact is observational only — there is no blocking mechanism
    // in the Claude Code hook contract (no compactionDecision field,
    // exit 2 does NOT prevent compaction). All we can do is observe and
    // log. The handler ran (it may have sent a Slack notification); now
    // just exit cleanly.
    process.exit(0)
  }

  // notification — no output needed
  process.exit(0)
}

main().catch(() => {
  // Safety net — any uncaught error must never wedge the session.
  process.exit(0)
})
