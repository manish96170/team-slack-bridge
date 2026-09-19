// D39/D40 — Harness-neutral away-mode policy. Decides WHAT to gate and
// HOW to fail, without knowing which harness is asking. Tool-name
// normalization lives here so adapters don't each need their own alias
// map. Mirrors core/acp-backends.js's registry pattern.

const DEFAULT_GATED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit']

// Claude says Bash/Edit/Write; OpenCode says bash/edit/write/read.
const TOOL_ALIASES = new Map([
  ['bash', 'Bash'],
  ['edit', 'Edit'],
  ['write', 'Write'],
  ['read', 'Read'],
  ['notebookedit', 'NotebookEdit'],
])

export function normalizeToolName(name) {
  if (!name) return name
  return TOOL_ALIASES.get(name.toLowerCase()) || name
}

export function shouldGate(toolName, { config } = {}) {
  const gatedTools = config?.awayMode?.gatedTools || DEFAULT_GATED_TOOLS
  const normalized = normalizeToolName(toolName)
  return gatedTools.some(t => normalizeToolName(t) === normalized)
}

// D39 — The fail-mode divergence is the heart of this change.
// Claude Code can defer (exit 0 with no output -> falls through to the
// local prompt). OpenCode cannot — its only signal is `throw`, which is
// a hard deny. A per-harness capability descriptor encodes this rather
// than pretending one policy fits both.
const HARNESS_CAPABILITIES = {
  claude: { canDefer: true },
  opencode: { canDefer: false },
  codex: { canDefer: false },
  gemini: { canDefer: false },
}

export function failMode(harness) {
  const caps = HARNESS_CAPABILITIES[harness]
  return caps?.canDefer ? 'defer' : 'deny'
}

export function getHarnessCapabilities(harness) {
  return HARNESS_CAPABILITIES[harness] || { canDefer: false }
}
