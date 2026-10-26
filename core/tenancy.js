// Phase 1 of the multi-tenancy roadmap (ROADMAP.md's "Multi-tenancy as a
// configurable deployment mode") -- refactor only, no new capability yet.
//
// resolveAccount() is the one seam the hosted/remote profile's request
// handling (mcp/http.js) now goes through to get { env, config, dbPath }.
// In 'single' mode -- the only mode that actually does anything today --
// it returns exactly what the caller already had, byte-identical to the
// pre-refactor behavior: D6's "one deployment, one workspace" is now ONE
// implementation of this interface, not the only possible one.
//
// 'multi' mode is scaffolded here (the config key exists, is validated, and
// is read) but deliberately refuses every call rather than pretending to
// work: there is no tenant store yet (that's Phase 2 -- see ROADMAP.md),
// so a 'team_id' on an incoming request has nowhere real to resolve to.
// Silently behaving like 'single' for a 'multi'-flagged install would be
// exactly the kind of cross-tenant mistake Phase 3's adversarial testing
// exists to catch later -- better to fail loudly and clearly now than let
// anything be built on top of a mode that doesn't actually isolate
// anything yet.

const TENANCY_MODES = new Set(['single', 'multi'])

export function normalizeTenancy(raw = {}) {
  const mode = TENANCY_MODES.has(raw?.mode) ? raw.mode : 'single'
  return { mode }
}

// principal is accepted now (not yet used by 'single') so the call site in
// mcp/http.js doesn't need to change again when Phase 2 adds the tenant
// store -- resolveAccount(), not its caller, is where team_id -> tenant
// resolution will live.
export function resolveAccount({ config, env, dbPath, principal } = {}) {
  const { mode } = normalizeTenancy(config?.slackbotMcp?.tenancy)

  if (mode === 'single') {
    return { ok: true, mode, env, config, dbPath }
  }

  // mode === 'multi': no tenant store exists yet (Phase 2: an encrypted
  // team_id -> { botToken, config, repoRegistry } store, provisioned via
  // cli/tenants.js first, a self-serve OAuth flow later). Refuse clearly --
  // this must never be mistaken for "multi mode works, just unauthenticated".
  return { ok: false, mode, error: 'multi-tenancy-not-yet-implemented', retryable: false }
}
