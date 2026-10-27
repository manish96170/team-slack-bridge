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

## Multi-tenancy as a configurable deployment mode (in progress — Phases 1-2 shipped, 2026-10-26)

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

1. **[DONE 2026-10-26, PLAN D53] Refactor only, no new capability.** `core/tenancy.js`'s
   `resolveAccount()` is now the seam `mcp/http.js` goes through for
   `{ env, config, dbPath }`; `slackbotMcp.tenancy.mode` (`"single"` default) is
   byte-identical to pre-refactor behavior, asserted by `test/tenancy.test.js`.
   `"multi"` is accepted as a config value but refuses every call at the time of
   this step — see step 2 below, now shipped (hand-provisioning half, D54).
2. **[DONE 2026-10-26, PLAN D54 — hand-provisioning half only] Build multi mode
   behind the flag, default off.** `core/tenant-store.js` + `cli/tenants.js`
   shipped; `"multi"` mode now really resolves a Slack `team_id` to that
   tenant's own `env`/`config`/`dbPath` instead of refusing everything (D53's
   placeholder). **Refined from the original wording below**: the store maps
   `team_id → home directory` (same shape as the local account registry,
   D21) rather than an encrypted blob — no tenant secret ever enters
   `tenants.json`, so there is no blob to encrypt. Still open from this
   step's original scope: per-tenant `allowedTools`/`repoAccess`/rate limits
   today come from whatever that tenant's own `slack-config.json` already
   supports (same keys every single-tenant install already has — nothing
   tenant-specific needed there), but there is still no dedicated
   cross-tenant audit view (today's `.ledger.sqlite`/`remote_audit` table is
   per-tenant, inside that tenant's own home dir, which is arguably the
   right call for isolation but means "show me every tenant's recent calls"
   needs its own aggregation tool, not yet built). Original scope, for
   reference:
   - **[DONE] `cli/tenants.js add|list|remove`** — same shape as
     `core/accounts.js`/`cli/accounts.js` (D21), writing a `team_id → home`
     row. Enough to onboard any known company by hand, no self-serve UX.
     Unblocks step 3 and step 4's "we host it for you" tier on its own.
   - **A real OAuth self-serve install flow** (still not started, deferred
     on purpose) — a public "Add to Slack" install endpoint that completes
     Slack's OAuth handshake, resolves the resulting `team_id`, and calls
     the same `addTenant()` `cli/tenants.js` already uses under the hood.
     Deliberately deferred until there's a concrete company asking for it.
3. **[DONE 2026-10-27, PLAN D61] Dogfood internally before offering it to anyone
   external.** Ran multi mode against this org's own real workspaces,
   company-a (T0123ABC) and company-b (T0456DEF), as the first real
   tenants, provisioned via `cli/tenants.js` (D54). Full install flow exercised
   live, not simulated: Public Distribution's OAuth consent screen (showing
   "Where do you want to use Example Slack App?" → "Company B"), the
   self-signed-cert browser warning, `get-workspace-token.js` capturing a real
   bot token, and `scripts/dogfood-multi-tenant.mjs` proving both team_ids
   resolve through one shared `/mcp` endpoint to a tenant whose own real token
   passes a live `auth.test` — confirmed distinct identities (`botAuth.team`:
   "Company A" vs "Company B") via direct `cli/doctor.js --json` runs against
   each tenant's own home dir. Unit-level cross-tenant isolation was already
   covered (`test/tenancy.test.js`'s "two registered tenants never
   cross-resolve" test, PLAN D54) — this closes the live-run gap that test
   couldn't reach on its own. **One real gap still open, deliberately not
   claimed as closed here**: this ran the `/mcp` HTTP layer directly over
   `127.0.0.1` with real HMAC-signed requests — proving the signature check,
   `resolveAccount()`, and live Slack connectivity are all correct with real
   credentials. It does **not** prove Slack's own Slackbot MCP Client can
   reach this endpoint over the public internet, which needs an actual public
   HTTPS URL plus a workspace admin approving the MCP connector in each
   workspace — a separate, larger, still-not-attempted step.
4. **Not started. Offer both tiers once step 3 is clean, not before.** Self-host (today's
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

## Plain-English cross-company messaging — "DM <person> in <company>" (not started, 2026-10-27)

Today, sending a DM to someone requires knowing two things no human carries around in
their head: their raw Slack user ID (different per workspace — confirmed live, the
same person has a different ID in each of this install's two companies) and either the
right `TSB_HOME` path or a `--account <name>` argument. Goal: let a human (or the
`skill/SKILL.md` natural-language skill) say "DM pulkit.jain in anchor: hi" or, using a
configured default, just "DM pulkit.jain: hi" — no path, no ID, no `TSB_HOME` in sight.

**Most of the needed mapping infrastructure already exists — this is mostly wiring, not
new state.** `core/accounts.js` (D21) already does exactly "human-chosen name → home
directory, with one of them markable as the default" via `addAccount`/
`setDefaultAccount`/`resolveAccountHome` (which already falls back to the registered
default when no name is given, and already fails clearly — `account-not-found` — when
one is given but unregistered). That registry is the right place for "company alias" to
live — it is a **different, deliberately separate** registry from `core/tenant-store.js`
(D54)'s `team_id → home` mapping, which exists to resolve an *incoming signed webhook*,
not a *human-typed name*. Keep them separate; don't merge "which real workspace sent
this request" with "which account does a human mean by a short name."

**What's actually new:**

1. **A combined resolve-and-send primitive**, e.g. `core/people.js`'s
   `dmByName({ accountName, personName, text, asUser, dryRun })`:
   - Resolve the account via `resolveAccountHome(accountName)` — `accountName` omitted
     uses the registered default; if **no default is configured either**, refuse with a
     specific, distinct error (e.g. `no-company-specified-and-no-default-configured`) —
     never guess which company. This specific error code is what lets the skill layer
     (not application code) decide to ask a clarifying question instead of failing
     silently or picking one.
   - Load that account's `env`/`config` (`loadAccountContext`, already exists).
   - Resolve `personName` via `core/directory.js`'s `lookupUser` (live Slack search,
     already handles ambiguous-match refusal — reuse that, don't reinvent it).
   - Send via `core/dm.js`'s `dm()` using the resolved account's token.
   - Return one combined result carrying both the resolved account name and the
     resolved person, so a single log line (if logged) explains the whole action
     instead of two disjoint ones — this was the main real argument from the earlier
     "two calls vs one tool" discussion (account-context mismatch between the lookup
     and the send becomes structurally impossible once one call does both with the
     same resolved account).
2. **`cli/dm-by-name.js`** (and a `tsb-dm` bin entry, same pattern as every other
   command added this cycle): `--to "<name>" [--company <alias>] --text "<text>"
   [--as-user] [--dry-run] [--json]`. `--company` omitted uses the registered default;
   its total absence (no default either) must surface the same specific refusal code
   above, in `--json` output, for the skill to catch.
3. **`skill/SKILL.md` update**: document the natural-language pattern ("DM/message
   `<person>` in `<company>`: `<text>`" and, using the default, "DM/message `<person>`:
   `<text>`") and an explicit instruction for the agent reading the skill: **if the
   underlying command refuses with `no-company-specified-and-no-default-configured`,
   ask the user which company before doing anything else — never pick one.** This is a
   prompt-level instruction, not new application code; the CLI stays non-interactive
   like every other command in this repo, consistent with D3's "a proposal, never an
   instruction that executes itself" posture — the *skill* is where asking happens, not
   the tool.
4. **One-time setup note, not new code**: for an existing install where a company is
   only registered in `tenants.json` (team_id-keyed, D54) and not yet in `accounts.json`
   under a friendly name, a human has to register it there too —
   `node cli/accounts.js add anchor --home <that tenant's home>` — before "in anchor"
   means anything. Document this in the feature's own usage text, not a new migration.

**Deliberately generic, not hardcoded to any company name** — "anchor" above is only an
example alias one install's owner chose for themselves via `setDefaultAccount`/
`addAccount`; nothing in `core/accounts.js` or the new `dmByName()` ever hardcodes a
specific company. Any install picks its own aliases and its own default, or configures
no default at all and lets the skill ask every time.

**Open question before implementation starts**: should `dmByName` try the config-file
`resolveUser` (fast, no network, but only knows people already in `slack-config.json`'s
`users` list) before falling back to the live `lookupUser` search, or always go straight
to the live search (slower, but complete, and what's already been used successfully in
this session)? Leaning live-first for completeness, but worth deciding deliberately
rather than defaulting silently either way.

