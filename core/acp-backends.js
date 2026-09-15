// ACP backend registry (PLAN: ACP thread sessions). Each entry is how to
// spawn that backend as an ACP v1 agent over stdio. An env-var override
// lets an operator point at a locally installed binary instead of npx,
// mirroring the CODEX_PATH pattern the codex-acp adapter itself uses.
//
// Model selection is deliberately NOT hardcoded here — ACP's
// session/set_config_option option IDs/values are agent-specific and
// unverified per backend; that mapping is a follow-on, not assumed.

export const DEFAULT_BACKEND = 'claude'

export const backends = {
  claude: {
    name: 'claude',
    description: 'Claude via @agentclientprotocol/claude-agent-acp (Claude Agent SDK — API-key or Bedrock billed, not the Claude Code CLI subscription)',
    command: () => process.env.TSB_ACP_CLAUDE_PATH || 'npx',
    args: () => (process.env.TSB_ACP_CLAUDE_PATH ? [] : ['-y', '@agentclientprotocol/claude-agent-acp']),
    isAuthConfigured: env => !!(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_USE_BEDROCK),
  },
  codex: {
    name: 'codex',
    description: 'Codex via @agentclientprotocol/codex-acp (bundles Codex; ChatGPT login, OPENAI_API_KEY/CODEX_API_KEY, or a custom gateway)',
    command: () => process.env.TSB_ACP_CODEX_PATH || 'npx',
    args: () => (process.env.TSB_ACP_CODEX_PATH ? [] : ['-y', '@agentclientprotocol/codex-acp']),
    isAuthConfigured: env => !!(env.OPENAI_API_KEY || env.CODEX_API_KEY),
  },
  opencode: {
    name: 'opencode',
    description: 'OpenCode, native ACP support (opencode acp)',
    command: () => process.env.TSB_ACP_OPENCODE_PATH || 'opencode',
    args: () => ['acp'],
    isAuthConfigured: () => true,
  },
  gemini: {
    name: 'gemini',
    description: 'Gemini CLI, native ACP support (gemini --acp)',
    command: () => process.env.TSB_ACP_GEMINI_PATH || 'gemini',
    args: () => ['--acp'],
    isAuthConfigured: env => !!env.GEMINI_API_KEY,
  },
}

export function getBackend(name) {
  return backends[name || DEFAULT_BACKEND] || null
}

export function listBackendNames() {
  return Object.keys(backends)
}
