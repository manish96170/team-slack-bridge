const AUTH_TYPES = new Set(['no_auth', 'slack_identity_auth', 'manual_auth', 'dynamic_client_registration'])

export function normalizeSlackbotMcp(raw = {}) {
  const authType = AUTH_TYPES.has(raw.authType) ? raw.authType : 'slack_identity_auth'
  return {
    enabled: !!raw.enabled,
    serverKey: raw.serverKey || 'team-slack-bridge',
    url: raw.url || '',
    authType,
    authProviderKey: raw.authProviderKey || '',
    exposeWriteTools: !!raw.exposeWriteTools,
    allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools : [],
    rateLimitPerMinute: Number.isInteger(raw.rateLimitPerMinute) && raw.rateLimitPerMinute > 0 ? raw.rateLimitPerMinute : 30,
  }
}

export function getSlackbotMcpStatus(config) {
  const settings = normalizeSlackbotMcp(config?.slackbotMcp)
  const hasHttpsUrl = /^https:\/\//.test(settings.url)
  const hasSlackIdentityAuth = settings.authType === 'slack_identity_auth'
  const hasAuthProvider = settings.authType !== 'manual_auth' || !!settings.authProviderKey

  return {
    enabled: settings.enabled,
    serverKey: settings.serverKey,
    urlConfigured: !!settings.url,
    authType: settings.authType,
    exposeWriteTools: settings.exposeWriteTools,
    allowedTools: settings.allowedTools,
    rateLimitPerMinute: settings.rateLimitPerMinute,
    manifestScopeRequired: 'mcp:connect',
    manifestBlockRequired: 'mcp_servers',
    ready:
      !settings.enabled ||
      (!!settings.serverKey && hasHttpsUrl && hasSlackIdentityAuth && hasAuthProvider),
    error: settings.enabled && !hasHttpsUrl
      ? 'slackbot-mcp-requires-https-url'
      : settings.enabled && !hasSlackIdentityAuth
        ? 'slackbot-mcp-requires-slack-identity-auth'
      : settings.enabled && !hasAuthProvider
        ? 'manual-auth-requires-auth-provider-key'
        : undefined,
  }
}
