// What the agent's own process is allowed to see and touch (PLAN D74).
// Two independent layers, both applied to every command an agent runs in a
// terminal: a scrubbed environment (no Slack/cloud credentials to steal) and,
// for delegated sessions on macOS, a sandbox that denies the bridge's home
// directory outright, which is what actually keeps an agent away from the
// policy file, its key and the config. Neither covers a backend that runs its
// own tools outside the client's terminal handlers; that gap is documented in
// docs/HUB.md rather than hidden.

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ALWAYS_SCRUB = [/^SLACK_/i, /^TSB_/i]
const STRICT_SCRUB = [
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /API_?KEY/i,
  /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$/i,
]

// 'base' always runs (listener-only secrets never belong in an agent shell);
// 'strict' is for delegated sessions, where the person steering the agent is
// not the person whose credentials are in the environment.
export function scrubEnv(env, mode = 'base') {
  const patterns = mode === 'strict' ? [...ALWAYS_SCRUB, ...STRICT_SCRUB] : ALWAYS_SCRUB
  const out = {}
  for (const [name, value] of Object.entries(env)) {
    if (patterns.some(pattern => pattern.test(name))) continue
    out[name] = value
  }
  return out
}

// Sandbox rules match real paths, so a symlinked home (or /tmp -> /private/tmp)
// would otherwise slip past a rule written against the unresolved path.
export function protectedPaths(extra = []) {
  const defaults = [join(homedir(), '.team-slack-bridge'), process.env.TSB_HOME].filter(Boolean)
  const all = [...defaults, ...extra].filter(Boolean)
  const resolved = all.map(path => {
    try {
      return realpathSync(path)
    } catch {
      return null
    }
  })
  return [...new Set([...all, ...resolved.filter(Boolean)])]
}

export function sandboxAvailable() {
  return process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
}

function escapeProfilePath(path) {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function buildSandboxProfile(paths) {
  const rules = paths.map(path => `(deny file-read* file-write* (subpath "${escapeProfilePath(path)}"))`)
  return ['(version 1)', '(allow default)', ...rules].join('\n')
}

// Wraps a spawn target so the child runs under the sandbox profile. Returns
// the command/args unchanged when no sandbox applies, so callers need no
// branching of their own.
export function wrapForSandbox({ command, args = [], mode, paths }) {
  if (mode === 'off' || !sandboxAvailable()) return { command, args, sandboxed: false }
  return { command: '/usr/bin/sandbox-exec', args: ['-p', buildSandboxProfile(paths), command, ...args], sandboxed: true }
}
