# Roadmap

Longer-horizon direction, beyond the immediate `TODO.md` list. Nothing here is
committed or scheduled — it's the set of ideas that have come up, worth recording so
they don't need to be re-derived later. See `PLAN.md` for what's already decided and
why; this file is deliberately *not* a decisions log.

## Near-term (natural next steps from where things are)

- **Idle-session cleanup** — an explicit reaper (cron-friendly, like
  `cli/daemon.js start` already is) that closes ACP sessions idle past some
  configurable threshold, freeing the backend connection. The `TODO.md` gap this
  addresses is real; this is the most likely next piece of actual code.
- **Verify Codex/Gemini CLI model selection live** — run a real session against each,
  confirm `session/new`'s `configOptions` actually advertises a `"model"` category the
  way Claude/OpenCode do, and note any quirks in `PLAN.md`.
- **FEATURES.md ACP section** — mirror README's write-up into FEATURES.md's
  per-feature format for consistency with every other feature in this repo.
- **Session concurrency cap** — a configurable `agentSessions.maxConcurrent`,
  rejecting a new session start once hit rather than letting it grow unbounded.
- **Away-mode ask hygiene** — the `asks` table has no TTL sweep and Slack messages are
  never edited after an answer or a timeout, so buttons stay live forever and rows
  accumulate. Away mode makes both far more visible than the occasional manual
  `cli/ask.js` did: a `chat.update` rewriting the message to "✅ Approved" plus a reaper
  for stale rows. Related: the timeout/answer TOCTOU in `core/ask.js` can strand an
  approval as `answered` while reporting `timeout` to the caller.
- **Away-mode delegation** — approvals currently go to `config.owner.slackUserId` only.
  Letting the owner delegate to a named list would be a *third* trust grant alongside
  D24 `allowedUsers` and D31 `allowedControllers`, and should get its own config key
  rather than overloading either, on the same reasoning D31 records.
- **Per-tool gate granularity** — `awayMode.gatedTools` matches on tool name alone, so
  `Bash` is all-or-nothing. Gating on the *argument* (e.g. only `git push`, only writes
  outside the repo) is the obvious next axis, and `updatedInput` in the Claude hook
  contract suggests the harness would even allow rewriting a call rather than just
  allowing or denying it.

## Medium-term (real feature work, not yet started)

- **Proactive session resume at listener startup** — today resume is lazy (only on
  the next reply to a thread). An eager pass at startup that re-establishes sessions
  marked `active` would mean a restart is fully invisible rather than "works on the
  next message." Deliberately deferred in D29 to keep the first cut simple; revisit
  once idle-cleanup exists too (otherwise eager resume would also eagerly resurrect
  sessions that should have been reaped).
- **Antigravity backend**, if/when it gains a confirmed ACP agent mode — the backend
  registry (`core/acp-backends.js`) is built to make adding a fifth entry mechanical
  once there's something real to point at.
- **Turn on the remote/hosted Slackbot MCP profile for real** — it's fully built
  (D5/D20) and tested, but has never been deployed outside this machine. Doing so
  means a public HTTPS endpoint, `SLACK_SIGNING_SECRET`, and a deliberate decision on
  which channels are postable/readable — not just flipping `enabled: true`.
- **Local MCP HTTP daemon, live multi-client verification** — get a second real MCP
  client (not just this session) connected concurrently, confirm account-mode
  behavior end-to-end rather than only via unit tests.

## Multi-tenancy as a configurable deployment mode (not yet started, 2026-10-26)

Today D6 is a hard "no" for the hosted/remote profile — one deployment, one bot
install, one workspace, by design (PLAN.md). This does not reopen D6 as a default;
it proposes a **second, opt-in profile** alongside it, selected by config rather
than by forking the codebase — for the case where this tool is handed to another
company (or a different org/subsidiary under this one) that either wants to
self-host their own single-tenant instance (today's behavior, unchanged) or wants
a shared instance someone else operates on their behalf.

**Why this is smaller than it sounds.** `core/*.js` already takes tokens/config as
parameters and holds no ambient state (D2) — nothing in `core/` needs to change.
The only new concept is a resolution layer in front of it:

```
request → resolveAccount(request) → { botToken, config, repoRegistry } → core/*.js (unchanged)
```

- `tenancyMode: "single"` (new config key, default) — `resolveAccount()` returns
  the one local account from `TSB_HOME`, byte-identical to today's only behavior.
  Must stay provably identical to today — this is the safety net that keeps every
  existing install unaffected by any of the rest of this.
- `tenancyMode: "multi"` (opt-in, net-new) — `resolveAccount()` reads `team_id`/
  `enterprise_id` out of the Slack-signed request and looks it up in a tenant
  store, returning that tenant's own isolated token/config/repo registry. A
  Slack app's signing secret is per-app, not per-install, so verifying the
  request itself is identical across every tenant of one app — the only new
  trust-sensitive logic is the `team_id → tenant record` lookup, which keeps the
  risky surface small and specifically testable rather than smeared across the
  whole MCP registry.

**Staged build-out, in order — do not skip ahead:**

1. **Refactor only, no new capability.** Introduce `resolveAccount()` and route
   today's single-tenant path through it. Behavior stays identical; D6's "no"
   becomes one implementation of the interface instead of the only possible one.
   Worth doing on its own, independent of whether step 2 ever happens.
2. **Build multi mode behind the flag, default off.** Needs a tenant store
   (encrypted at rest — once more than a couple of tenants' secrets live in one
   place, a flat file is not an acceptable posture, unlike today's per-install
   `slack-config.json`/`accounts.json`); per-tenant `allowedTools`/`repoAccess`/
   rate limits enforced from that row instead of a static config file; and
   per-tenant audit logging, since multiple companies' calls now interleave in
   one process's logs and support/incident response needs to filter cleanly by
   `team_id`. **Provisioning is two separate pieces, built in this order, both
   eventually needed rather than one chosen instead of the other:**
   - **`cli/tenants.js add|list|remove|set-default`** (build first, low effort) —
     same shape as `core/accounts.js`/`cli/accounts.js` (D21), just writing a
     tenant row (team_id/enterprise_id → botToken/config/repoRegistry) into the
     tenant store instead of a `TSB_HOME` directory. Enough to onboard any known
     company by hand (one command per company), with zero self-serve UX to
     build. This unblocks step 3's dogfooding and step 4's "we host it for you"
     tier on its own — no OAuth flow required to get there.
   - **A real OAuth self-serve install flow** (build later, materially more
     effort, only once self-onboarding is an actual requirement rather than a
     hypothetical) — a public "Add to Slack" install endpoint that completes
     Slack's OAuth handshake, resolves/validates the resulting `team_id`, and
     calls the same tenant-row-write `cli/tenants.js add` already uses under the
     hood, so a company can onboard itself with no manual step on this side.
     Deliberately deferred until there's a concrete company asking for it —
     building it speculatively means maintaining a public-facing OAuth surface
     (redirect URIs, token exchange, CSRF/state handling) for an audience that
     may never need it.
3. **Dogfood internally before offering it to anyone external.** Run multi mode
   in staging with this org's own workspaces (hornblowercruises, anchoros) as the
   first tenants. Write adversarial tests aimed specifically at the one failure
   mode that actually matters: a request carrying tenant A's `team_id` must never
   resolve tenant B's token/config/repo, under any malformed or edge-case input.
   This is the highest-stakes code in the whole feature and deserves
   disproportionate test investment relative to its size — the equivalent of
   D23's `assertInsideRepo`/D32's symlink-escape fix, but for tenants instead of
   filesystem paths.
4. **Offer both tiers once step 3 is clean, not before.** Self-host (today's
   single-tenant profile — hand over the codebase + manifest, they run their own
   instance, nothing shared with anyone) or managed/shared (they install the one
   shared Slack app, get added as a tenant row, run nothing themselves). Same
   codebase either way — the choice is a deployment decision, never a fork.

**Resolved (2026-10-26): build both, in the order above, not an either/or.**
`cli/tenants.js` (hand-provisioning) ships first and is enough on its own for a
small, known set of companies onboarded by hand — including every step through
Phase 4's "we host it for you" tier. The OAuth self-serve flow is real future
scope, not speculative, but is sequenced *after* it, triggered by an actual
company asking to self-onboard rather than built ahead of that need. Keeping both
on the roadmap now (instead of picking one and dropping the other) means step 2
isn't redesigned later when self-serve does become a real requirement — the OAuth
flow is additive on top of the same tenant-store/`cli/tenants.js` write path,
not a replacement for it.

**Explicitly not reopening:** D6 stays "no" as the *default* and for every
existing single-tenant install. This section is additive — a second profile,
opt-in, config-selected — never a replacement, and single-tenant installs must
never be able to tell the difference from the inside.

## Ideas, not yet designed

- **Session transcripts / export** — `cli/agent-session.js list` shows session
  metadata; there's no way yet to pull a full transcript of what an ACP session
  actually did (tool calls, file edits, terminal output) after the fact. Could live
  in `agent_sessions.metadata` or a separate table.
- **Per-session cost/usage surfacing** — `usage_update` is now tracked and acted on
  (the 80%-context handoff warning), but only in memory and only as a threshold
  trigger. Persisting it (e.g. in `agent_sessions.metadata`) and surfacing it
  on demand — a `/agent-session usage` subcommand, or in `slack_doctor` — is still
  open. `usage_update.cost` (present on the type, optional) isn't read at all yet.
- **Persist context-limit-handoff state across a restart** — `contextState`,
  `handoffPath`, `transcript`, and `pendingRewind` (core/acp-sessions.js) are
  in-memory only today; a restart mid-gate or mid-rewind-Q&A silently drops them.
  Persisting to `agent_sessions.metadata` would close this, symmetric with how
  `acpSessionId` already survives a restart for resume.
- **Cross-workspace ACP sessions** — today an ACP session is scoped to one Slack
  workspace via the single-account-by-default model (D21's opt-in multi-account
  support exists for the *bridge* side, but ACP sessions themselves don't yet pick an
  account the way `startAgentSession` picks a repo/backend). Would need its own
  design pass, not a small addition.
- **Web dashboard for session status** — `listAgentSessions` already returns
  structured data; a small local-only web UI (reusing the existing `listen/http.js`
  HTTP surface) could visualize active sessions instead of only `cli/agent-session.js
  list`/Slack threads.
