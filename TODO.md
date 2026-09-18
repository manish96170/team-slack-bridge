# TODO

Status snapshot, most recent work at the top. See `PLAN.md` for the full decisions
log (D1–D33) and architecture; this file is the scannable done/pending list.
`ROADMAP.md` is the longer-horizon direction.

## Done

- [x] Core posting/DM/scheduling/reactions/progress-messages, CLI + local MCP server
      (stdio, full tool set) + Slack `skill/SKILL.md`
- [x] Human-in-the-loop `ask`/approve primitive (DM-based, button + free-text capture)
- [x] Locked-down remote/hosted Slackbot MCP profile (D5/D5a/D5b/D20) — built, not
      currently deployed (`slackbotMcp.enabled: false`)
- [x] Local multi-account support (D21) + shared local MCP HTTP daemon (D22)
- [x] Security-audited (no secrets, no lifecycle scripts, `npm audit` clean),
      installed globally and verified working on this machine. Published to npm as
      `team-slack-bridge` — `0.1.0`, `0.1.1`, `0.1.2`, `0.1.4` are live on the
      registry; `0.1.5` carries everything after the `0.1.4` publish (id-based
      close/reopen, the codex-review lifecycle fixes, the README overhaul, the
      App Home redesign).
- [x] Fixed npm-distribution-specific bugs: config cold-start path defaulting inside
      the install dir (would get wiped by `npm update`), `bin` path convention,
      `build:sea` correctly scoped to repo-clone-only
- [x] **ACP-driven Slack thread sessions — all 4 planned phases, plus review fixes:**
  - [x] Phase 1: named repo registry (D23), owner+allowlist start gate (D24), ACP
        client on `@agentclientprotocol/sdk` (D27), fs/terminal serving scoped to the
        repo, permission requests rendered as in-thread Approve/Deny (not DM),
        debounced progress rendering, `/agent-session start` slash command
  - [x] Phase 2: `@mention` keyword trigger, message-shortcut trigger (modal)
  - [x] Phase 3: `--model name`, fully protocol-driven via `session/new`'s
        `configOptions` (D28) — no hardcoded per-backend model tables
  - [x] Phase 4: session survives a listener restart via `session/resume` or
        `session/load`, whichever the backend advertises (D29)
  - [x] Stop rights separated from start rights (D30/D31) —
        `agentSessions.allowedControllers` is a distinct grant from `allowedUsers`;
        typing `stop`/`exit` in a session's thread closes it, no slash command needed
  - [x] Pre-publish review fixes (D32): `.env` credentials weren't reaching the
        spawned backend process at all (silent Bedrock/API-key failure); no error
        handling around session start/resume (stuck-forever "starting…" message);
        symlink escape past the repo boundary check; race condition on two rapid
        replies both trying to resume the same thread (`withKeyLock`)
  - [x] Live-testing fixes (D32/D33 follow-ons): approval-kind asks were capturable
        by plain free text (silently denying a pending approval); the very first
        prompt of a new session wasn't lock-protected against a concurrent reply
  - [x] D33: a DM directly to the bot can start a session too (mention keyword
        doesn't apply in a DM context)
  - [x] `cli/agent-session.js list` — see recorded sessions (ACP or manual),
        filterable by status/kind
  - [x] `/agent-session reopen <id>` — deliberately bring back a session you
        closed on purpose (stop/exit/close all persist `status:'closed'`, which
        tryResumeSession refuses on sight by design); just flips the DB row back
        to `active` so the next reply in its original thread resumes it normally
  - [x] `/agent-session close <id>` / `close all` — found live that Slack slash
        commands NEVER carry `thread_ts` (confirmed against Slack's own docs:
        developer slash commands can't be invoked inside threads at all), so the
        original `/agent-session close` (assumed it could read the thread it was
        run from) could never actually work; replaced with id-based close plus a
        close-all-in-this-channel option, D31-gated per session
- [x] **Live-verified on this machine**: Socket Mode listener connected, DM from the
      bot to the owner, an ACP session started against the `dashboard` repo
      (`/Users/Manish.Sharma/hornblower/UI/dashboard`), one session per thread with
      working follow-up replies, Claude via Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`) and
      OpenCode (native `AWS_REGION` detection, OpenCode Zen credentials) both
      confirmed reachable as backends
- [x] **Thread replies post as a new message per turn** instead of editing the first
      "starting…" message in place (was the default for every reply after the first)
- [x] **Per-user repo scoping** (`agentSessions.repoAccess`) — `allowedUsers` grants
      the right to start/resume sessions at all; which named repos a given user may
      point one at is now a separate, optional, backward-compatible grant
- [x] **Trusted-app DM triggers** (`agentSessions.trustedApps`) — a specific Slack
      app (`bot_id`/`app_id`) can DM-trigger a session on a named human's behalf,
      scoped to DMs only (a review pass caught and fixed a first version that
      accidentally granted channel-wide session control instead)
- [x] **Multiple DM/mention trigger aliases** (`agentSessions.mentionKeywords`) —
      e.g. both `"start session"` and `"@etd start session"` can trigger the same way
- [x] **Context-limit handoff**: ACP's `usage_update` (real `used`/`size` token
      counts, not a heuristic) is tracked per turn; crossing
      `agentSessions.contextWarningThreshold` (default `0.8`) has the agent
      self-summarize, writes a handoff file under `~/.team-slack-bridge/handoffs/`,
      and gates further replies until the user picks `here` (fresh session in-thread,
      seeded from the handoff), `new thread` (manual), or `compact` (best-effort
      nudge — ACP has no real on-demand compaction request, confirmed against the
      SDK schema; only an agent-initiated `compaction_update` notification exists,
      which is also now wired up)
- [x] **`rewind`** — approximates a rewind/checkpoint ACP does not actually have
      (confirmed: no such method or concept anywhere in the protocol) by asking how
      far back and how much detail, then starting a fresh session seeded from the
      bridge's own saved transcript of the last N exchanges
- [x] All of the above went through several rounds of `opencode --agent sol` review,
      which caught and fixed: `core/identity.js`'s config loader silently dropping
      every one of the new `agentSessions.*` fields above (so none of them would have
      worked at all without this catch); `new thread` not actually closing the
      session; rewind seeding a fresh session from an empty transcript or a failed
      internal summary; a race between `closeAgentSession` and the new
      here/rewind session-replacement flow (now share the same per-thread lock);
      `here`/`new-thread`/`rewind` bypassing the D31 close-rights check
      (`closeAgentSession` already enforced this; the new flows initially didn't)

## Pending / known gaps

- [ ] **Idle/abandoned session cleanup** — a session nobody ever runs `/agent-session
      close` (or types `stop`/`exit`) on stays `status:'active'` in the DB and its
      backend connection process keeps running indefinitely. No idle-timeout exists.
      Real operational gap for a long-running install.
- [ ] **No max-concurrent-sessions cap / rate limiting** on how many ACP sessions can
      be open at once — each is a real spawned backend process (well, one process per
      *backend name*, but unbounded sessions multiplexed onto it).
- [ ] **Per-backend model `configId`/value strings unverified for Codex and Gemini
      CLI** — only Claude (Bedrock) and OpenCode have been exercised live so far;
      Codex/Gemini's actual `session/new` `configOptions` shape is unconfirmed.
- [ ] **`amazon-bedrock/us.openai.gpt-5.6-luna` returned a server error** (ref
      `err_0b3fcc4f`) during one live attempt via OpenCode — unclear if transient
      (Bedrock/OpenCode-side) or a real gap; worth re-testing before relying on it.
- [ ] **Antigravity (`agy`) backend** — no confirmed ACP support found in research;
      deliberately not built. Revisit if `agy --help`/docs later show an ACP mode.
- [ ] **Local MCP HTTP daemon (D21/D22)** — unit-tested, not live end-to-end verified
      (needs a second real MCP client actually connecting over HTTP).
- [ ] **Remote/hosted Slackbot MCP profile** — fully built (D5/D20) but never actually
      turned on/deployed publicly; still `slackbotMcp.enabled: false`.
- [ ] **No automated test for real `session/resume`/`session/load` RPCs** against a
      live backend — only the guard-clause/safety logic (D24 gate, closed-session
      rejection, missing-metadata rejection) is unit-tested. The actual resume
      mechanics were confirmed live during manual testing, not via `npm test`.
- [ ] **FEATURES.md has no dedicated ACP section** — the write-up lives entirely in
      `README.md`'s "ACP agent sessions" section; FEATURES.md's per-feature format
      doesn't have a matching entry. Minor doc-consistency gap, not a code gap.
- [ ] **Message-shortcut manifest entry** requires manually merging into each
      deployed Slack app's manifest — no automated "push this update to my live app"
      tooling exists (by design — this repo doesn't hold Slack API app-management
      credentials).
- [ ] **No live testing of the context-limit handoff / rewind / trusted-app DM
      paths** — all covered by unit tests against fake ACP sessions, none run against
      a real Slack workspace or a real backend process. Highest-risk untested
      surface right now: whether a real backend actually emits `usage_update` in
      practice, and the `here`/`new thread`/`compact`/`rewind` Slack message flows.
- [ ] **`contextState`/`handoffPath`/`transcript`/`pendingRewind` are in-memory only**
      — a listener restart mid-context-limit-gate (or mid-rewind Q&A) loses that
      state entirely; the session just resumes normally, ungated, no follow-up
      questions pending. Same lazy-resume tradeoff as D29, just not called out
      separately before now.
