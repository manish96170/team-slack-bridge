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

import { preToolUse, preCompact, stop, notification } from '../core/hooks.js'
import { normalizeToolName } from '../core/away-policy.js'

function loadBridgeContext() {
  // Lazy import — the plugin is loaded once at OpenCode startup, but
  // context (env/config/dbPath) should be read fresh per invocation so
  // config changes (like awayMode.gatedTools) take effect without restart.
  const { loadContext } = require('../cli/context.js')
  return loadContext()
}

// OpenCode plugin entry point
export const AwayModePlugin = async ({ project, client, $, directory, worktree }) => {
  return {
    'tool.execute.before': async (input, output) => {
      let ctx
      try {
        ctx = loadBridgeContext()
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

    'session.idle': async (input) => {
      let ctx
      try { ctx = loadBridgeContext() } catch { return }
      await notification(
        { notification_type: 'idle_prompt', message: 'OpenCode session is idle.' },
        { env: ctx.env, config: ctx.config, dbPath: ctx.dbPath }
      )
    },

    'experimental.session.compacting': async (input) => {
      let ctx
      try { ctx = loadBridgeContext() } catch { return }
      await preCompact(
        { trigger: 'auto' },
        { env: ctx.env, config: ctx.config, dbPath: ctx.dbPath }
      )
    },
  }
}

export default AwayModePlugin
