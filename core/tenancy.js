// Phase 1 of the multi-tenancy roadmap (ROADMAP.md's "Multi-tenancy as a
// configurable deployment mode") -- refactor only, no new capability yet.
//
// resolveAccount() is the one seam the hosted/remote profile's request
// handling (mcp/http.js) now goes through to get { env, config, dbPath }.
// In 'single' mode -- the only mode that actually did anything at Phase 1 --
// it returns exactly what the caller already had, byte-identical to the
// pre-refactor behavior: D6's "one deployment, one workspace" is now ONE
// implementation of this interface, not the only possible one.
//
// Phase 2 (PLAN D54) added 'multi' mode's real resolution: a verified Slack
// team_id (never trusted from an unauthenticated caller -- see
// mcp/http.js's slackPrincipal(), which only exists after /mcp's signature
// check) is looked up in core/tenant-store.js's registry. An unknown
// team_id, or a 'multi'-flagged request with no team_id at all, refuses
// clearly rather than falling back to any other tenant's data -- there is
// no "default" tenant by design, unlike the local-only account registry
// (core/accounts.js, D21) that single-tenant installs use.

import { resolveTenantContext } from './tenant-store.js'

const TENANCY_MODES = new Set(['single', 'multi'])

export function normalizeTenancy(raw = {}) {
  const mode = TENANCY_MODES.has(raw?.mode) ? raw.mode : 'single'
  return { mode }
}

// principal is the already-verified Slack identity extracted by the caller
// (mcp/http.js's slackPrincipal()) -- never raw request input. 'single'
// mode ignores it; 'multi' mode is the one place it is actually used.
export function resolveAccount({ config, env, dbPath, principal } = {}) {
  const { mode } = normalizeTenancy(config?.slackbotMcp?.tenancy)

  if (mode === 'single') {
    return { ok: true, mode, env, config, dbPath }
  }

  // mode === 'multi'
  const teamId = principal?.team_id
  if (!teamId) return { ok: false, mode, error: 'multi-tenancy-requires-team-id', retryable: false }

  const tenant = resolveTenantContext(teamId)
  if (!tenant.ok) return { ok: false, mode, error: tenant.error, retryable: false }

  return { ok: true, mode, teamId, enterpriseId: tenant.enterpriseId, env: tenant.env, config: tenant.config, dbPath: tenant.dbPath }
}

