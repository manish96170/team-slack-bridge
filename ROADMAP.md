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
