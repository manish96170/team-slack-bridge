// D39 — OpenCode plugin adapter for away mode. Exports an async plugin
// per OpenCode's plugin API (https://opencode.ai/docs/plugins/).
// Translates neutral verdicts from core/hooks.js into OpenCode's
// throw-to-deny model.
//
// D39 fail-mode divergence: OpenCode has no "defer to local prompt" —
// its only signal is `throw` (hard deny). On timeout, this adapter
// throws with a message saying it was a bridge timeout rather than a
// policy denial, because a dead turn is recoverable and a silent
// approval is not.

import { preToolUse, preCompact, stop as stopHandler, notification } from '../core/hooks.js'
import { normalizeToolName } from '../core/away-policy.js'

// Lazy import via dynamic ESM import() — the plugin is loaded once at
// OpenCode startup, but context (env/config/dbPath) should be read fresh
// per invocation so config changes take effect without restart. Cannot
// use require() here — package.json has "type": "module".
let _loadContext
async function loadBridgeContext() {
  if (!_loadContext) {
    const mod = await import('../cli/context.js')
    _loadContext = mod.loadContext
  }
  return _loadContext()
}

// OpenCode plugin entry point
export const AwayModePlugin = async ({ project, client, $, directory, worktree }) => {
  return {
    'tool.execute.before': async (input, output) => {
      let ctx
      try {
        ctx = await loadBridgeContext()
      } catch {
        return // bridge not configured — don't block
      }
      const result = await preToolUse(
        { tool_name: normalizeToolName(input.tool), tool_input: output.args },
        { env: ctx.env, config: ctx.config, dbPath: ctx.dbPath, harness: 'opencode', skipDaemonCheck: false }
      )
      if (result.verdict === 'deny') {
        throw new Error(result.reason || 'Denied via Slack (away mode)')
      }
      // 'allow' and 'skip' pass through silently
    },

    // OpenCode's session.idle is the equivalent of Claude's Stop hook —
    // "the session finished its work and wants to stop". The stop handler
    // asks Slack what to do next; if the user replies with an instruction,
    // the handler returns verdict:'block' with the instruction as the
    // reason, which we surface as a thrown message so OpenCode continues.
    'session.idle': async (input) => {
      let ctx
      try { ctx = await loadBridgeContext() } catch { return }
      const result = await stopHandler(
        { session_id: input?.sessionId || 'opencode' },
        { env: ctx.env, config: ctx.config, dbPath: ctx.dbPath, harness: 'opencode', skipDaemonCheck: false }
      )
      if (result.verdict === 'block') {
        throw new Error(result.reason || 'Continue with instruction from Slack')
      }
      // verdict='allow' or 'skip' — let the session stop
    },

    'experimental.session.compacting': async (input) => {
      let ctx
      try { ctx = await loadBridgeContext() } catch { return }
      await preCompact(
        { trigger: 'auto' },
        { env: ctx.env, config: ctx.config, dbPath: ctx.dbPath }
      )
    },
  }
}

export default AwayModePlugin
